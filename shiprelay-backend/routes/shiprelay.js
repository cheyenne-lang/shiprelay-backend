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
    
    console.log(`Found ${data.data?.length || 0} shipment(s) for order ref: ${order_ref}`);
    res.json(data);
  } catch (err) {
    console.error('ShipRelay error:', err);
    res.status(500).json({ 
      error: 'Failed to fetch shipment',
      details: err.message
    });
  }
});

export default router;

async function cancelShopifyFulfillment(shipmentData) {
  if (!shipmentData?.order_ref || !process.env.SHOPIFY_ACCESS_TOKEN || !process.env.SHOPIFY_SHOP_DOMAIN) {
    console.log('Skipping Shopify fulfillment cancellation - missing credentials or order reference');
    return;
  }

  try {
    // Use order name search instead of order ID - order_ref should include the #
    const orderNumber = shipmentData.order_ref.replace('#', '');
    
    // Build proper Shopify API URL using store ID
    const storeId = process.env.SHOPIFY_SHOP_DOMAIN.replace(/\/$/, '');
    const apiBaseUrl = `https://${storeId}.myshopify.com`;
    
    // First, find the order by name using the search API
    const orderSearchUrl = `${apiBaseUrl}/admin/api/2025-01/orders.json?name=${orderNumber}&status=any`;
    const orderResponse = await fetch(orderSearchUrl, {
      headers: {
        'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN,
        'Content-Type': 'application/json',
        'User-Agent': 'ShipRelay-Integration/1.0'
      }
    });

    if (!orderResponse.ok) {
      const errorText = await orderResponse.text();
      console.error(`Failed to find Shopify order: ${orderResponse.status}`);
      console.error(`URL: ${orderSearchUrl}`);
      console.error(`Response: ${errorText}`);
      return;
    }

    const orderData = await orderResponse.json();
    if (!orderData.orders || orderData.orders.length === 0) {
      console.log(`No Shopify order found for order name #${orderNumber}`);
      return;
    }

    const order = orderData.orders[0];
    const orderId = order.id; // This should be the numeric ID like 6413424099553
    
    console.log(`Found Shopify order ID: ${orderId} for order #${orderNumber}`);
    
    // Now get the fulfillments for this order using proper API URL
    const apiUrl = `${apiBaseUrl}/admin/api/2025-01/orders/${orderId}/fulfillments.json`;
    
    const fulfillmentsResponse = await fetch(apiUrl, {
      headers: {
        'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN,
        'Content-Type': 'application/json',
        'User-Agent': 'ShipRelay-Integration/1.0'
      }
    });

    if (!fulfillmentsResponse.ok) {
      const errorText = await fulfillmentsResponse.text();
      console.error(`Failed to fetch Shopify fulfillments: ${fulfillmentsResponse.status}`);
      console.error(`URL: ${apiUrl}`);
      console.error(`Response: ${errorText}`);
      return;
    }

    const fulfillmentsData = await fulfillmentsResponse.json();
    const activeFulfillments = fulfillmentsData.fulfillments?.filter(f => f.status !== 'cancelled') || [];

    for (const fulfillment of activeFulfillments) {
      const cancelUrl = `${apiBaseUrl}/admin/api/2025-01/orders/${orderId}/fulfillments/${fulfillment.id}/cancel.json`;
      const cancelResponse = await fetch(cancelUrl, {
        method: 'POST',
        headers: {
          'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN,
          'Content-Type': 'application/json',
          'User-Agent': 'ShipRelay-Integration/1.0'
        },
        body: JSON.stringify({
          fulfillment: {
            notify_customer: false,
            reason: 'other'
          }
        })
      });

      if (cancelResponse.ok) {
        console.log(`✅ Cancelled Shopify fulfillment ${fulfillment.id} for order ${orderId}`);
      } else {
        console.error(`❌ Failed to cancel Shopify fulfillment ${fulfillment.id}:`, await cancelResponse.text());
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
