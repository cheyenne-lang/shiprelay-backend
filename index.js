import express from 'express';
import dotenv from 'dotenv';
import cors from 'cors';
import shiprelayRoutes from './routes/shiprelay.js';

// Load environment variables
dotenv.config();

const app = express();

// Enable CORS
app.use(cors());

// Parse JSON bodies
app.use(express.json());

// Mount ShipRelay proxy routes
app.use('/api/shiprelay', shiprelayRoutes);

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
});
