// Test with direct fetch instead of SDK - simulating browser behavior
const apiKey = 're_iJhBsVbG_BgzTkm6Tycb1bPACMkiSqrei';

console.log('=== Testing direct fetch to Resend API ===');

// Test 1: Direct API call like the working test script
console.log('\n--- Test 1: Direct fetch ---');
const response = await fetch('https://api.resend.com/emails', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiKey}`
  },
  body: JSON.stringify({
    from: 'info@acschennai.com',
    to: 'info@acschennai.com',
    subject: 'Direct fetch test',
    html: '<p>Testing direct fetch from Node.js</p>'
  })
});

const data = await response.json();
console.log('Status:', response.status);
console.log('Response:', JSON.stringify(data, null, 2));

if (!response.ok) {
  console.error('FAILED:', data);
} else {
  console.log('SUCCESS:', data.id);
}

// Test 2: Using SDK in async/await style (like browser would)
console.log('\n--- Test 2: SDK async/await simulation ---');
const { Resend } = await import('resend');
const resend = new Resend(apiKey);

const result = await resend.emails.send({
  from: 'info@acschennai.com',
  to: 'info@acschennai.com',
  subject: 'SDK test',
  html: '<p>Testing SDK</p>'
});

console.log('SDK Result:', JSON.stringify(result, null, 2));

console.log('\n=== Tests complete ===');