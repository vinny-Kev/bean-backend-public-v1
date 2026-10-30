import { config } from '../config.js';

const escapeHtml = (value) =>
    String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Links are built only from the configured trusted origin. Secrets travel in the URL fragment
// (#token=...), which browsers never send to servers, proxies or access logs.
export const appLink = (path, fragment = '') => `${config.appBaseUrl}${path}${fragment ? `#${fragment}` : ''}`;

const defaultFooter = 'If this wasn’t you, you can ignore this email.';

const layout = ({ title, lines, action, footer = defaultFooter }) => {
    const text = [title, '', ...lines, ...(action ? ['', `${action.label}: ${action.url}`] : []), '', footer, '', '— Bean'].join('\n');
    const html = `<div style="font-family:system-ui,sans-serif;max-width:480px;margin:auto;color:#2b2118">
<h1 style="font-size:20px">${escapeHtml(title)}</h1>
${lines.map((line) => `<p>${escapeHtml(line)}</p>`).join('\n')}
${action ? `<p><a href="${escapeHtml(action.url)}" style="display:inline-block;padding:10px 16px;background:#4a2c17;color:#fff;border-radius:6px;text-decoration:none">${escapeHtml(action.label)}</a></p>` : ''}
<p style="color:#6b5d50;font-size:13px">${escapeHtml(footer)}</p></div>`;
    return { text, html };
};

const codeLine = (code, minutes) => `Your code is ${code}. It expires in ${minutes} minutes and works once. Bean staff will never ask you for it.`;

export const templates = {
    verifyEmail: ({ code, minutes }) => ({
        subject: 'Verify your email for Bean',
        ...layout({ title: 'Verify your email', lines: [codeLine(code, minutes)] }),
    }),
    loginCode: ({ code, minutes }) => ({
        subject: 'Your Bean sign-in code',
        ...layout({
            title: 'Confirm it’s you',
            lines: ['We noticed a sign-in from a device we don’t recognise.', codeLine(code, minutes)],
            footer: 'If you didn’t try to sign in, change your password.',
        }),
    }),
    sensitiveActionCode: ({ code, minutes, action }) => ({
        subject: 'Your Bean confirmation code',
        ...layout({
            title: 'Confirm a sensitive change',
            lines: [`You asked to ${action}.`, codeLine(code, minutes)],
            footer: 'If you didn’t ask for this, change your password.',
        }),
    }),
    emailChangeCode: ({ code, minutes }) => ({
        subject: 'Confirm your new email for Bean',
        ...layout({ title: 'Confirm your new email address', lines: [codeLine(code, minutes)] }),
    }),
    emailChangeNotice: ({ phase }) => ({
        subject: phase === 'confirmed' ? 'Your Bean email address was changed' : 'Someone asked to change your Bean email',
        ...layout({
            title: phase === 'confirmed' ? 'Your email address was changed' : 'Email change requested',
            lines: [
                phase === 'confirmed'
                    ? 'The email on your Bean account was changed. Sign-ins now use the new address.'
                    : 'A request was made to change the email on your Bean account. Nothing changes until the new address is confirmed.',
            ],
            footer: 'If this wasn’t you, reset your password right away.',
        }),
    }),
    passwordReset: ({ url, minutes }) => ({
        subject: 'Reset your Bean password',
        ...layout({
            title: 'Reset your password',
            lines: [`Use the button below within ${minutes} minutes. The link works once.`],
            action: { label: 'Choose a new password', url },
        }),
    }),
    passwordChanged: () => ({
        subject: 'Your Bean password was changed',
        ...layout({
            title: 'Your password was changed',
            lines: ['Your password was changed and every signed-in session was ended.'],
            footer: 'If this wasn’t you, reset your password right away.',
        }),
    }),
    accountExists: ({ url }) => ({
        subject: 'Someone tried to register with your email',
        ...layout({
            title: 'You already have a Bean account',
            lines: ['Someone used this address to register. If it was you, sign in instead; you can reset your password if you forgot it.'],
            action: { label: 'Go to sign in', url },
        }),
    }),
    invitation: ({ organization, inviter, role, url, days }) => ({
        subject: `${inviter} invited you to ${organization} on Bean`,
        ...layout({
            title: `Join ${organization} on Bean`,
            lines: [
                `${inviter} invited you to join ${organization} as ${role === 'admin' ? 'an administrator' : `a ${role}`}.`,
                `The invitation works once and expires in ${days} days. Sign in (or create an account) with this email address to accept it.`,
            ],
            action: { label: 'View invitation', url },
        }),
    }),
};
