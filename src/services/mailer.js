'use strict';

const nodemailer = require('nodemailer');

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Large, high-contrast HTML email that is readable on a phone by an older reader. */
function renderHtml(subject, text, appUrl) {
  const body = escapeHtml(text).replace(/\n/g, '<br>');
  const link = appUrl
    ? `<p style="margin-top:24px"><a href="${escapeHtml(appUrl)}" style="background:#0f5e57;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-size:18px">Open Kendra</a></p>`
    : '';
  return `<!doctype html><html><body style="margin:0;background:#f6f1e9;font-family:Arial,sans-serif">
<div style="max-width:560px;margin:0 auto;padding:24px;background:#ffffff;color:#1f2933">
<h1 style="font-size:22px;color:#0f5e57;margin:0 0 16px">${escapeHtml(subject)}</h1>
<p style="font-size:18px;line-height:1.6;margin:0">${body}</p>${link}
<p style="font-size:13px;color:#52606d;margin-top:32px">Sent by Kendra care circle. Reminders support, and never replace, advice from a doctor.</p>
</div></body></html>`;
}

/**
 * Sends email through SMTP (e.g. Gmail with an app password). Without credentials it
 * falls back to "log" mode so the app still works end to end in development.
 */
function createMailer(config, logger) {
  const { host, port, user, pass, from } = config.smtp;
  const transport =
    user && pass
      ? nodemailer.createTransport({ host, port, secure: port === 465, auth: { user, pass } })
      : null;

  return {
    mode: transport ? 'smtp' : 'log',
    async send({ to, subject, text, simulate = false }) {
      const addresses = to.map((r) => r.email);
      if (!transport || simulate) {
        logger.info('mail.simulated', { to: addresses.length, subject });
        return { delivered: false, mode: simulate ? 'simulated' : 'log' };
      }
      try {
        await transport.sendMail({
          from: `"Kendra Care" <${from}>`,
          bcc: addresses, // recipients never see each other's addresses
          subject,
          text,
          html: renderHtml(subject, text, config.publicUrl),
        });
        return { delivered: true, mode: 'smtp' };
      } catch (error) {
        logger.error('mail.failed', { subject, message: error.message });
        return { delivered: false, mode: 'smtp', error: 'Delivery failed' };
      }
    },
  };
}

module.exports = { createMailer, renderHtml, escapeHtml };
