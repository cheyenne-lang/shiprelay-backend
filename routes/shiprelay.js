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

router.get('/shipment/ping', (req, res) => {
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

router.put('/shipment/:id/hold', async (req, res) => {
  try {
    const token = await getShipRelayToken();
    const response = await fetch(`https://console.shiprelay.com/api/v2/shipments/${req.params.id}/hold`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({}) 
    });

    const text = await response.text();
    try {
      const data = JSON.parse(text);
      res.status(response.status).json(data);
    } catch (parseErr) {
      console.error('ShipRelay hold failed with non-JSON response:', text);
      res.status(500).json({ error: 'Invalid response from ShipRelay', raw: text });
    }
  } catch (err) {
    console.error('Error holding shipment:', err);
    res.status(500).json({ error: 'Failed to hold shipment' });
  }
});

router.put('/shipment/:id/release', async (req, res) => {
  try {
    const token = await getShipRelayToken();
    const response = await fetch(`https://console.shiprelay.com/api/v2/shipments/${req.params.id}/release`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`
      }
    });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err) {
    console.error('Error releasing shipment:', err);
    res.status(500).json({ error: 'Failed to release shipment' });
  }
});

router.patch('/shipment/:id/archive', async (req, res) => {
  try {
    const token = await getShipRelayToken();
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
