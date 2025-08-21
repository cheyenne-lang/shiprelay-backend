import express from 'express';
import dotenv from 'dotenv';
import shiprelayRoutes from './routes/shiprelay.js';

dotenv.config();

const app = express();
app.use(express.json());

// Mount ShipRelay proxy routes
app.use('/api/shiprelay', shiprelayRoutes);

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
});
