import { Resend } from 'resend';

const resend = new Resend('re_iJhBsVbG_BgzTkm6Tycb1bPACMkiSqrei');

// Test 1: Simple test like the working test-resend.js
console.log('=== Test 1: Simple send ===');
const { data, error } = await resend.emails.send({
  from: 'info@acschennai.com',
  to: 'info@acschennai.com',
  subject: 'Test from local',
  html: '<p>Local test</p>'
});

if (error) {
  console.error('Test 1 failed:', error);
} else {
  console.log('Test 1 success:', data?.id);
}

// Test 2: Simulate what the Contact component does
console.log('\n=== Test 2: Contact form simulation ===');

const form = {
  name: 'Test User',
  company: 'Test Corp',
  email: 'test@test.com',
  phone: '1234567890',
  projectType: 'PMC / Project Management Consultancy',
  message: 'This is a test message'
};

const subject = `Project Enquiry${form.projectType ? ` — ${form.projectType}` : ''} from ${form.name}`;
const html = `<h2>New Project Enquiry</h2>
<p><strong>Name:</strong> ${form.name}</p>
<p><strong>Company:</strong> ${form.company || 'N/A'}</p>
<p><strong>Email:</strong> ${form.email}</p>
<p><strong>Phone:</strong> ${form.phone || 'N/A'}</p>
<p><strong>Project Type:</strong> ${form.projectType || 'Not specified'}</p>
<hr />
<p><strong>Message:</strong></p>
<p>${form.message.replace(/\n/g, '<br/>')}</p>`;

console.log('Subject:', subject);
console.log('HTML:', html.substring(0, 100) + '...');

const result = await resend.emails.send({
  from: 'info@acschennai.com',
  to: 'info@acschennai.com',
  subject: subject,
  html: html,
});

if (result.error) {
  console.error('Test 2 failed:', result.error);
} else {
  console.log('Test 2 success:', result.data?.id);
}

console.log('\n=== All tests complete ===');