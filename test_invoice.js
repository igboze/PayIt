const { generateInvoicePNG } = require('./src/invoice_generator');
generateInvoicePNG({
  invoiceNumber: 'INV-0001',
  clientName: 'Acme Ltd',
  clientEmail: null,
  items: [{ description: 'Web design', quantity: 1, unitPrice: 500 }],
  dueDate: '2025-07-15',
  notes: null,
  businessName: 'PayIT',
  walletAddress: '0xf7629aBCBc22576Af38c2e9DB19FE5a4DB53f419',
  issueDate: '2025-06-28'
}).then(p => console.log('SUCCESS:', p)).catch(e => console.error('FAIL:', e.message)); 
