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

router.get('/shipment', async (req, res) => {
  const { order_ref } = req.query;
  if (!order_ref) return res.status(400).json({ error: 'Missing order_ref' });

  try {
    const token = await getShipRelayToken();
    const response = await fetch(`https://console.shiprelay.com/api/v2/shipments?order_ref=${encodeURIComponent(order_ref)}`, {
      headers: { Authorization: `Bearer ${token}` }
    });

    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error('ShipRelay error:', err);
    res.status(500).json({ error: 'Failed to fetch shipment' });
  }
});

export default router;