import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';

// Three transports, chosen explicitly by MAIL_TRANSPORT:
//   smtp    real delivery (required in production)
//   outbox  development only: writes each message to .mail-outbox/ (gitignored) so a developer can read the code
//   capture tests: keeps messages in memory; nothing leaves the process
// Message bodies (which contain codes and links) are never written to application logs.

const captured = [];
export const capturedMessages = () => captured;
export const clearCapturedMessages = () => {
    captured.length = 0;
};

let smtpTransport;
const getSmtpTransport = async () => {
    if (!smtpTransport) {
        const { default: nodemailer } = await import('nodemailer');
        const { host, port, secure, user, password } = config.mail;
        smtpTransport = nodemailer.createTransport({
            host,
            port,
            secure,
            requireTLS: !secure, // STARTTLS is mandatory when not using implicit TLS
            ...(user && { auth: { user, pass: password } }),
            connectionTimeout: 10_000,
            greetingTimeout: 10_000,
            socketTimeout: 20_000,
            disableFileAccess: true,
            disableUrlAccess: true,
        });
    }
    return smtpTransport;
};

const headerSafe = (value) => String(value).replace(/[\r\n]+/g, ' ').trim();

// Sends one message. Returns true when handed to the transport; false (never throws) on failure,
// so a mail outage cannot break a request after its database work has committed.
export const sendMail = async ({ to, subject, text, html, template }, { requestId } = {}) => {
    const message = {
        from: `${headerSafe(config.mail.fromName)} <${config.mail.fromAddress}>`,
        to: headerSafe(to),
        subject: headerSafe(subject),
        text,
        html,
    };
    try {
        if (config.mail.transport === 'capture') {
            captured.push({ ...message, template, to: message.to.toLowerCase() });
        } else if (config.mail.transport === 'outbox') {
            await mkdir('.mail-outbox', { recursive: true });
            await writeFile(
                `.mail-outbox/${Date.now()}-${randomUUID().slice(0, 8)}.txt`,
                `To: ${message.to}\nSubject: ${message.subject}\n\n${text}\n`,
                'utf8',
            );
        } else {
            await (await getSmtpTransport()).sendMail(message);
        }
        console.log(JSON.stringify({ level: 'info', event: 'mail_sent', template, transport: config.mail.transport, requestId }));
        return true;
    } catch (error) {
        console.error(
            JSON.stringify({
                level: 'error',
                event: 'mail_failed',
                template,
                transport: config.mail.transport,
                errorName: error.name,
                ...(error.code && { code: error.code }),
                requestId,
            }),
        );
        return false;
    }
};
