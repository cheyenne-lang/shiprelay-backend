import express from 'express';
import fetch from 'node-fetch';

const router = express.Router();

// Token cache to avoid repeated login calls
let tokenCache = {
  token: null,
  expiry: null
};

async function getShipRelayToken() {
  // Check if we have a valid cached token (expire after 50 minutes to be safe)
  if (tokenCache.token && tokenCache.expiry && Date.now() < tokenCache.expiry) {
    console.log('Using cached ShipRelay token');
    return tokenCache.token;
  }

  console.log('Fetching new ShipRelay token...');
  const response = await fetch('https://console.shiprelay.com/api/v2/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: process.env.SHIPRELAY_EMAIL,
      password: process.env.SHIPRELAY_PASSWORD
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to login to ShipRelay: ${response.status} - ${errorText}`);
  }
  
  const data = await response.json();
  
  // Cache the token for 50 minutes (ShipRelay tokens typically expire in 1 hour)
  tokenCache.token = data.access_token;
  tokenCache.expiry = Date.now() + (50 * 60 * 1000);
  
  console.log('ShipRelay token cached successfully');
  return data.access_token;
}

router.get('/shipment/ping', (_, res) => {
  res.status(200).json({ status: 'awake' });
});

router.get('/shipment', async (req, res) => {
  const { order_ref } = req.query;
  
  // Input validation
  if (!order_ref || typeof order_ref !== 'string' || order_ref.trim().length === 0) {
    return res.status(400).json({ 
      error: 'Missing or invalid order_ref parameter',
      details: 'order_ref must be a non-empty string'
    });
  }

  try {
    const token = await getShipRelayToken();
    const response = await fetch(`https://console.shiprelay.com/api/v2/shipments?order_ref=${encodeURIComponent(order_ref.trim())}`, {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      }
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`ShipRelay API error: ${response.status} - ${errorText}`);
      return res.status(response.status).json({ 
        error: 'ShipRelay API error',
        status: response.status,
        details: response.status === 404 ? 'No shipments found' : 'API request failed'
      });
    }

    const data = await response.json();
    
    // Sort shipments by updated_at (most recent first) if we have multiple
    if (data.data && Array.isArray(data.data)) {
      data.data.sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
    }
    
    res.json(data);
  } catch (err) {
    console.error('ShipRelay error:', err);
    res.status(500).json({ 
      error: 'Failed to fetch shipment',
      details: err.message
    });
  }
});

// Get product details by ID
router.get('/product/:id', async (req, res) => {
  const { id } = req.params;
  
  if (!id || isNaN(id)) {
    return res.status(400).json({ 
      error: 'Invalid product ID',
      details: 'Product ID must be a valid number'
    });
  }

  try {
    const token = await getShipRelayToken();
    const response = await fetch(`https://console.shiprelay.com/api/v2/products/${id}`, {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      }
    });

    if (!response.ok) {
      if (response.status === 404) {
        return res.status(404).json({ error: 'Product not found' });
      }
      const errorText = await response.text();
      return res.status(response.status).json({ 
        error: 'ShipRelay API error',
        details: 'Failed to fetch product details'
      });
    }

    const productData = await response.json();
    
    // Log the complete product data for debugging
    console.log('=== FULL PRODUCT OBJECT ===');
    console.log(JSON.stringify(productData, null, 2));
    console.log('=== END PRODUCT OBJECT ===');
    
    res.json(productData);
  } catch (err) {
    console.error('Product fetch error:', err);
    res.status(500).json({ 
      error: 'Failed to fetch product',
      details: err.message
    });
  }
});

export default router;

async function cancelShopifyFulfillment(shipmentData) {
  if (!shipmentData?.order_ref || !process.env.SHOPIFY_ACCESS_TOKEN || !process.env.SHOPIFY_SHOP_DOMAIN) {
    return;
  }

  try {
    // Use order name search instead of order ID - order_ref should include the #
    const orderNumber = shipmentData.order_ref.replace('#', '');
    
    // Build proper Shopify GraphQL API URL
    const storeId = process.env.SHOPIFY_SHOP_DOMAIN.replace(/\/$/, '');
    const graphqlUrl = `https://${storeId}.myshopify.com/admin/api/2025-01/graphql.json`;
    
    // Step 1: Find the order by name using GraphQL
    const orderQuery = `
      query getOrderByName($query: String!) {
        orders(first: 1, query: $query) {
          edges {
            node {
              id
              name
              fulfillmentOrders(first: 10) {
                edges {
                  node {
                    id
                    status
                    requestStatus
                  }
                }
              }
            }
          }
        }
      }
    `;
    
    const orderResponse = await fetch(graphqlUrl, {
      method: 'POST',
      headers: {
        'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN,
        'Content-Type': 'application/json',
        'User-Agent': 'ShipRelay-Integration/1.0'
      },
      body: JSON.stringify({
        query: orderQuery,
        variables: { query: `name:${orderNumber}` }
      })
    });

    if (!orderResponse.ok) {
      return;
    }

    const orderData = await orderResponse.json();
    
    if (orderData.errors || !orderData.data?.orders?.edges?.length) {
      return;
    }

    const order = orderData.data.orders.edges[0].node;
    
    // Step 2: Submit cancellation requests for fulfillment orders
    const fulfillmentOrders = order.fulfillmentOrders.edges
      .map(edge => edge.node)
      .filter(fo => fo.status !== 'CANCELLED' && fo.requestStatus !== 'CANCELLATION_REQUESTED');
    
    if (fulfillmentOrders.length === 0) {
      console.log(`⚠️ No active fulfillment orders to cancel for ${order.name}. Status details:`);
      order.fulfillmentOrders.edges.forEach((edge, i) => {
        const fo = edge.node;
        console.log(`  FO ${i+1}: status="${fo.status}", requestStatus="${fo.requestStatus}"`);
      });
      return;
    }

    console.log(`📦 Cancelling ${fulfillmentOrders.length} fulfillment orders for Shopify order ${order.name}`);
    
    // Step 3: Submit cancellation request for each fulfillment order
    const cancellationMutation = `
      mutation fulfillmentOrderSubmitCancellationRequest($id: ID!, $message: String) {
        fulfillmentOrderSubmitCancellationRequest(id: $id, message: $message) {
          fulfillmentOrder {
            id
            status
            requestStatus
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    for (const fulfillmentOrder of fulfillmentOrders) {
      const cancellationResponse = await fetch(graphqlUrl, {
        method: 'POST',
        headers: {
          'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN,
          'Content-Type': 'application/json',
          'User-Agent': 'ShipRelay-Integration/1.0'
        },
        body: JSON.stringify({
          query: cancellationMutation,
          variables: { 
            id: fulfillmentOrder.id,
            message: 'Order archived in ShipRelay'
          }
        })
      });

      if (cancellationResponse.ok) {
        const cancellationData = await cancellationResponse.json();
        
        if (cancellationData.errors) {
          console.error(`❌ GraphQL errors for fulfillment order:`, cancellationData.errors);
        } else if (cancellationData.data?.fulfillmentOrderSubmitCancellationRequest?.userErrors?.length > 0) {
          console.error(`❌ User errors for fulfillment order:`, 
            cancellationData.data.fulfillmentOrderSubmitCancellationRequest.userErrors);
        } else {
          console.log(`✅ Successfully cancelled Shopify fulfillment for order ${order.name}`);
        }
      } else {
        console.error(`❌ Failed to cancel Shopify fulfillment for order ${order.name}`);
      }
    }
    
  } catch (err) {
    console.error('Error cancelling Shopify fulfillment:', err);
  }
}

router.patch('/shipment/:id/archive', async (req, res) => {
  try {
    const token = await getShipRelayToken();
    
    // Get shipment data first to extract order info for Shopify cancellation
    const shipmentResponse = await fetch(`https://console.shiprelay.com/api/v2/shipments/${req.params.id}`, {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      }
    });
    
    let shipmentData = null;
    if (shipmentResponse.ok) {
      const shipmentJson = await shipmentResponse.json();
      shipmentData = shipmentJson.data || shipmentJson;
    }

    const response = await fetch(`https://console.shiprelay.com/api/v2/shipments/${req.params.id}/archive`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({})
    });

    const text = await response.text();
    try {
      const data = JSON.parse(text);
      
      // Cancel Shopify fulfillment if archive was successful
      if (response.ok && shipmentData) {
        await cancelShopifyFulfillment(shipmentData);
      }
      
      res.status(response.status).json(data);
    } catch (parseErr) {
      console.error('ShipRelay archive failed with non-JSON response:', text);
      res.status(500).json({ error: 'Invalid response from ShipRelay', raw: text });
    }
  } catch (err) {
    console.error('Error archiving shipment:', err);
    res.status(500).json({ error: 'Failed to archive shipment' });
  }
});
