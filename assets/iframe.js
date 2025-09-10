// Initialize Zendesk client  
const client = window.ZAFClient ? window.ZAFClient.init() : { invoke: () => {} };

fetch('https://shiprelay-backend.onrender.com/api/shiprelay/shipment/ping').catch(err => {
  console.log('Backend wakeup failed (likely already warm)', err);
});

async function getShipmentsByOrderRef(orderRef) {
  try {
    const response = await fetch(`https://shiprelay-backend.onrender.com/api/shiprelay/shipment?order_ref=${encodeURIComponent(orderRef)}`);
    if (!response.ok) throw new Error('Failed to fetch shipments');

    const data = await response.json();
    const shipments = data?.data || [];

    console.log(`Found ${shipments.length} shipments for order ${orderRef}`);
    return shipments;
  } catch (error) {
    console.error('Error fetching shipments:', error);
    return [];
  }
}

function canArchiveShipment(status) {
  // Based on ShipRelay API, shipments can be archived unless they're already inactive
  const nonArchivableStatuses = ['inactive'];
  return !nonArchivableStatuses.includes(status?.toLowerCase());
}

function getStatusColor(status) {
  const statusColors = {
    'queued': '#f59e0b',      // amber
    'held': '#ef4444',        // red
    'requested': '#3b82f6',   // blue
    'processing': '#8b5cf6',  // purple
    'shipped': '#10b981',     // green
    'returned': '#f97316',    // orange
    'inactive': '#6b7280'     // gray
  };
  return statusColors[status?.toLowerCase()] || '#6b7280';
}

function createShipmentCard(shipment, index) {
  const canArchive = canArchiveShipment(shipment.status);
  const statusColor = getStatusColor(shipment.status);
  
  return `
    <div class="shipment-card" style="border-left: 4px solid ${statusColor};">
      <div class="shipment-header">
        <span class="shipment-title">Shipment #${index + 1}</span>
        <span class="shipment-status" style="color: ${statusColor};">${shipment.status || '--'}</span>
      </div>
      <div class="shipment-details">
        <p><strong>Shipment ID:</strong> ${shipment.id || '--'}</p>
        <p><strong>Updated:</strong> ${new Date(shipment.updated_at).toLocaleDateString() || '--'}</p>
        ${shipment.tracking?.tracking_number ? `<p><strong>Tracking:</strong> ${shipment.tracking.tracking_number}</p>` : ''}
      </div>
      <div class="shipment-actions">
        ${canArchive ? `<button class="archive-btn" data-shipment-id="${shipment.id}">Archive</button>` : '<span class="status-note">Already archived</span>'}
      </div>
    </div>
  `;
}

document.getElementById('searchBtn').addEventListener('click', async () => {
  const orderRef = document.getElementById('orderInput').value.trim();
  if (!orderRef) {
    alert('Please enter an Order Reference Number');
    return;
  }

  // Reset search form to normal size while searching
  const searchForm = document.getElementById('searchForm');
  searchForm.classList.remove('compact');
  document.getElementById('result').style.display = 'none';
  client.invoke('resize', { width: '100%', height: '300px' });

  const shipments = await getShipmentsByOrderRef(orderRef);

  if (shipments && shipments.length > 0) {
    console.log(`Found ${shipments.length} shipments:`, shipments);
    
    // Set customer info from first shipment
    const firstShipment = shipments[0];
    document.getElementById('custName').textContent = firstShipment.address?.name || '--';
    document.getElementById('custEmail').textContent = firstShipment.address?.email || '--';

    // Build shipments container HTML
    const shipmentsContainer = document.getElementById('shipmentsContainer');
    shipmentsContainer.innerHTML = shipments.map((shipment, index) => 
      createShipmentCard(shipment, index)
    ).join('');

    // Add event listeners to all archive buttons
    document.querySelectorAll('.archive-btn').forEach(button => {
      button.addEventListener('click', (e) => {
        const shipmentId = e.target.getAttribute('data-shipment-id');
        archiveShipment(shipmentId, orderRef);
      });
    });

    document.getElementById('result').style.display = 'block';

    // Make search form compact and resize app dynamically
    searchForm.classList.add('compact');
    
    // Calculate height based on number of shipments
    const baseHeight = 250;
    const cardHeight = 120;
    const totalHeight = baseHeight + (shipments.length * cardHeight);
    
    setTimeout(() => {
      client.invoke('resize', { width: '100%', height: `${Math.min(totalHeight, 600)}px` });
    }, 100);
  } else {
    alert('No shipments found for that Order Reference Number');
    document.getElementById('result').style.display = 'none';
  }
});

document.getElementById('orderInput').addEventListener('keydown', async (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    document.getElementById('searchBtn').click();
  }
});

async function archiveShipment(shipmentId, orderRef) {
  try {
    const response = await fetch(`https://shiprelay-backend.onrender.com/api/shiprelay/shipment/${shipmentId}/archive`, {
      method: 'PATCH'
    });

    if (!response.ok) throw new Error('Archive failed');

    alert('Shipment archived successfully');

    // Refresh the shipments list
    const shipments = await getShipmentsByOrderRef(orderRef);
    
    if (shipments && shipments.length > 0) {
      // Rebuild shipments container HTML
      const shipmentsContainer = document.getElementById('shipmentsContainer');
      shipmentsContainer.innerHTML = shipments.map((shipment, index) => 
        createShipmentCard(shipment, index)
      ).join('');

      // Re-add event listeners to archive buttons
      document.querySelectorAll('.archive-btn').forEach(button => {
        button.addEventListener('click', (e) => {
          const newShipmentId = e.target.getAttribute('data-shipment-id');
          archiveShipment(newShipmentId, orderRef);
        });
      });
    }
    
  } catch (err) {
    console.error('Archive failed:', err);
    alert('Archive failed');
  }
}

client.invoke('resize', { width: '100%', height: '300px' });