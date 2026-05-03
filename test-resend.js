import { Resend } from 'resend';

const resend = new Resend('re_iJhBsVbG_BgzTkm6Tycb1bPACMkiSqrei');

const { data, error } = await resend.emails.send({
  from: 'info@acschennai.com',
  to: 'info@acschennai.com',
  subject: 'Hello World',
  html: '<p>Congrats on sending your <strong>first email</strong>!</p>'
});

if (error) {
  console.error('Error:', error);
} else {
  console.log('Success! Email ID:', data?.id);
}