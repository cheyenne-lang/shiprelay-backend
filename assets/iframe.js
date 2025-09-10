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

function canEditShipment(status) {
  // Based on ShipRelay API, shipments can only be edited when in certain statuses
  const editableStatuses = ['queued', 'held'];
  return editableStatuses.includes(status?.toLowerCase());
}

function createShipmentCard(shipment, index) {
  const canArchive = canArchiveShipment(shipment.status);
  const canEdit = canEditShipment(shipment.status);
  const statusColor = getStatusColor(shipment.status);
  
  // Format shipping address
  const address = shipment.address;
  const shippingAddress = address ? 
    `${address.name || ''}<br>
     ${address.address1 || ''}${address.address2 ? ', ' + address.address2 : ''}<br>
     ${address.city || ''}, ${address.region || ''} ${address.zip || ''}<br>
     ${address.country || ''}`.replace(/,\s*<br>/g, '<br>').replace(/<br>\s*<br>/g, '<br>') 
    : 'Address not available';
  
  // Create ShipRelay console edit link using source_order_id
  const shiprelayLink = `https://console.shiprelay.com/admin/requests/${shipment.status}/${shipment.source_order_id}/edit?cursor=${shipment.id}&order=${shipment.order_ref}&caller=terminal&focus=${shipment.status}`;
  
  return `
    <div class="shipment-card" style="border-left: 4px solid ${statusColor};" data-shipment-index="${index}">
      <div class="shipment-header" onclick="toggleShipmentDetails(${index})">
        <span class="shipment-title">Shipment #${index + 1}</span>
        <div class="header-right">
          <span class="shipment-status" style="color: ${statusColor};">${shipment.status || '--'}</span>
          <span class="expand-icon">▼</span>
        </div>
      </div>
      <div class="shipment-details" style="display: none;">
        <p><strong>Name:</strong> ${address?.name || '--'}</p>
        <p><strong>Email:</strong> ${address?.email || '--'}</p>
        <div class="address-section">
          <p><strong>Shipping to:</strong></p>
          <div class="shipping-address">${shippingAddress}</div>
        </div>
        <p><strong>Updated:</strong> ${new Date(shipment.updated_at).toLocaleDateString() || '--'}</p>
        ${shipment.tracking?.tracking_number ? `<p><strong>Tracking:</strong> ${shipment.tracking.tracking_number}</p>` : ''}
        ${canEdit ? `<p><strong>ShipRelay:</strong> <a href="${shiprelayLink}" target="_blank" class="shiprelay-link">View/Edit Order →</a></p>` : ''}
        <div class="order-contents">
          <p><strong>Order Contents:</strong></p>
          <div class="items-list" data-shipment-index="${index}">
            ${shipment.items && shipment.items.length > 0 ? 
              shipment.items.map((item, itemIndex) => `
                <div class="order-item" data-item-index="${itemIndex}">
                  <span class="item-quantity">${item.quantity}x</span>
                  <span class="item-details">Loading product details...</span>
                </div>
              `).join('') : 
              '<div class="no-items">No items found</div>'
            }
          </div>
        </div>
      </div>
      <div class="shipment-actions" style="display: none;">
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
    
    // Customer info now displayed in individual cards

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

    // Load product details for all items
    await loadProductDetails(shipments);

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

async function fetchProductDetails(productId) {
  try {
    const response = await fetch(`https://shiprelay-backend.onrender.com/api/shiprelay/product/${productId}`);
    if (!response.ok) throw new Error('Failed to fetch product');
    return await response.json();
  } catch (error) {
    console.error(`Error fetching product ${productId}:`, error);
    return null;
  }
}

async function loadProductDetails(shipments) {
  for (let shipmentIndex = 0; shipmentIndex < shipments.length; shipmentIndex++) {
    const shipment = shipments[shipmentIndex];
    if (shipment.items && shipment.items.length > 0) {
      for (let itemIndex = 0; itemIndex < shipment.items.length; itemIndex++) {
        const item = shipment.items[itemIndex];
        
        // Debug: Log the item structure to see what fields are available
        console.log('Item structure:', item);
        
        // Try different possible product ID fields
        const productId = item.product_id || item.id || item.sku;
        
        if (productId) {
          // Find the item element
          const itemElement = document.querySelector(`[data-shipment-index="${shipmentIndex}"] [data-item-index="${itemIndex}"] .item-details`);
          if (itemElement) {
            console.log(`Fetching product details for ID: ${productId}`);
            // Fetch product details
            const product = await fetchProductDetails(productId);
            if (product) {
              console.log('Product details received:', product);
              itemElement.innerHTML = `${product.name || product.sku || `Product ${productId}`} - $${item.sub_total ? (item.sub_total).toFixed(2) : '0.00'}`;
            } else {
              console.log(`No product details found for ID: ${productId}`);
              itemElement.innerHTML = `Product ${productId} - $${item.sub_total ? (item.sub_total).toFixed(2) : '0.00'}`;
            }
          }
        } else {
          console.log('No product ID found in item:', item);
          const itemElement = document.querySelector(`[data-shipment-index="${shipmentIndex}"] [data-item-index="${itemIndex}"] .item-details`);
          if (itemElement) {
            itemElement.innerHTML = `Unknown Product - $${item.sub_total ? (item.sub_total).toFixed(2) : '0.00'}`;
          }
        }
      }
    }
  }
}

function toggleShipmentDetails(index) {
  const card = document.querySelector(`[data-shipment-index="${index}"]`);
  if (!card) return;
  
  const details = card.querySelector('.shipment-details');
  const actions = card.querySelector('.shipment-actions');
  const expandIcon = card.querySelector('.expand-icon');
  
  const isExpanded = details.style.display !== 'none';
  
  if (isExpanded) {
    // Collapse
    details.style.display = 'none';
    actions.style.display = 'none';
    expandIcon.textContent = '▼';
    expandIcon.style.transform = 'rotate(0deg)';
  } else {
    // Expand
    details.style.display = 'block';
    actions.style.display = 'flex';
    expandIcon.textContent = '▲';
    expandIcon.style.transform = 'rotate(180deg)';
  }
  
  // Adjust iframe height after expansion/collapse
  setTimeout(() => {
    const container = document.querySelector('.container');
    const containerHeight = container.scrollHeight;
    client.invoke('resize', { width: '100%', height: `${Math.max(containerHeight + 20, 300)}px` });
  }, 100);
}

client.invoke('resize', { width: '100%', height: '300px' });