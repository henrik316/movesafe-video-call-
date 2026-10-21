import nodemailer from 'nodemailer';

export function mailConfigured() {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_FROM);
}

export async function sendInviteMail({ to, link, company }) {
  if (!mailConfigured()) return { sent: false };
  const transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD || '' }
      : undefined,
  });
  await transport.sendMail({
    from: process.env.SMTP_FROM,
    to,
    subject: `${company || 'MoveSafe'} staff invite`,
    text: [
      'You have been invited to the MoveSafe video desk as staff.',
      'Open this one-time link to choose your password. It expires in 72 hours.',
      link,
      'If you were not expecting this, you can ignore it.',
    ].join('\n\n'),
  });
  return { sent: true };
}
