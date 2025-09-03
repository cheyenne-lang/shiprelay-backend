import express from 'express';
import fetch from 'node-fetch';

const router = express.Router();

async function getShipRelayToken() {
  const response = await fetch('https://console.shiprelay.com/api/v2/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: process.env.SHIPRELAY_EMAIL,
      password: process.env.SHIPRELAY_PASSWORD
    })
  });

  if (!response.ok) throw new Error('Failed to login to ShipRelay');
  const data = await response.json();
  return data.access_token;
}

router.get('/shipment/ping', (_, res) => {
  res.status(200).json({ status: 'awake' });
});

router.get('/shipment', async (req, res) => {
  const { order_ref } = req.query;
  if (!order_ref) return res.status(400).json({ error: 'Missing order_ref' });

  try {
    const token = await getShipRelayToken();
    const response = await fetch(`https://console.shiprelay.com/api/v2/shipments?order_ref=${encodeURIComponent(order_ref)}`, {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      }
    });

    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error('ShipRelay error:', err);
    res.status(500).json({ error: 'Failed to fetch shipment' });
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
    const baseUrl = process.env.SHOPIFY_SHOP_DOMAIN.replace(/\/$/, ''); // Remove trailing slash
    
    // First, find the order by name using the search API
    const orderSearchUrl = `${baseUrl}/api/2025-01/orders.json?name=${orderNumber}&status=any`;
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
    const orderId = order.id;
    
    // Now get the fulfillments for this order
    const apiUrl = `${baseUrl}/api/2025-01/orders/${orderId}/fulfillments.json`;
    
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
      const cancelUrl = `${baseUrl}/api/2025-01/orders/${orderId}/fulfillments/${fulfillment.id}/cancel.json`;
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
