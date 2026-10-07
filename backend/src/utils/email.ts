import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { Env } from './sessionManager';

export const DEFAULT_EMAIL_FROM = 'Comms Scribe <alex@scrivenly.com>';
const DEFAULT_SES_REGION = 'us-east-1';

/** Email settings, normally taken from Env (SES_REGION, EMAIL_FROM, EMAIL_BCC). */
export type EmailConfig = Pick<Env, 'SES_REGION' | 'EMAIL_FROM' | 'EMAIL_BCC'>;

// One client per region, reused across sends. Credentials come from the default
// AWS credential chain (the ECS task role in AWS, a profile locally).
const clients = new Map<string, SESv2Client>();
function getClient(region: string): SESv2Client {
	let client = clients.get(region);
	if (!client) {
		client = new SESv2Client({ region });
		clients.set(region, client);
	}
	return client;
}

/** Wrap a message in the Comms Scribe HTML template. */
export function renderEmailHtml(message: string): string {
	return `
							<body>
								<div align="center" style="font-family:Calibri, Arial, Helvetica, sans-serif;">
									<table width="600" cellpadding="0" cellspacing="0" border="0" style="font-family:Calibri, Arial, Helvetica, sans-serif">
									<tr style="background-color:white;"><td><table width="600" cellpadding="0">
									<tr>
									<td>
									<h1>Comms Scribe</h1>
									<p>` + message.replace(/\n/g, '<br>') +`
									</p></td></tr></table></td></tr></table></div></body>`;
}

/** Plain-text body: `<br>` tags become newlines. */
export function renderEmailText(message: string): string {
	return message.replace(/<br\s*[\/]?>/gi, "\n");
}

/** Optional parts of an email beyond the notification template. */
export interface SendEmailOptions {
	/** Reply-To address (validated by the caller). */
	replyTo?: string;
	/** A complete HTML body, sent as is instead of wrapping `message` in the template. */
	html?: string;
	/** A complete plain-text body, sent as is (defaults to `message` with <br> as newlines). */
	text?: string;
	/** Files sent with the email. Inline ones are shown where the HTML says `cid:<contentId>`. */
	attachments?: EmailAttachment[];
}

export interface EmailAttachment {
	fileName: string;
	contentType: string;
	content: Uint8Array;
	/** Set for an inline image: the HTML refers to it as `cid:<contentId>`. */
	contentId?: string;
}

/**
 * Send an email through SES v2. Returns 200 on success (callers used to receive
 * the HTTP status) and throws on failure. Without options, `message` is wrapped in the
 * Comms Scribe notification template.
 */
export async function sendEmail(
	toEmail: string | string[],
	subjectLine: string,
	message: string,
	config: EmailConfig,
	options: SendEmailOptions = {}): Promise<number> {
	const to = Array.isArray(toEmail) ? toEmail : [ toEmail ];
	const bcc = (config.EMAIL_BCC || []).filter((address) => address.length > 0);
	const command = new SendEmailCommand({
		FromEmailAddress: config.EMAIL_FROM || DEFAULT_EMAIL_FROM,
		Destination: {
			ToAddresses: to,
			...(bcc.length > 0 ? { BccAddresses: bcc } : {}),
		},
		...(options.replyTo ? { ReplyToAddresses: [ options.replyTo ] } : {}),
		Content: {
			Simple: {
				Subject: { Data: subjectLine, Charset: 'UTF-8' },
				Body: {
					Text: { Data: options.text ?? renderEmailText(message), Charset: 'UTF-8' },
					Html: { Data: options.html ?? renderEmailHtml(message), Charset: 'UTF-8' },
				},
				...(options.attachments && options.attachments.length > 0 ? {
					Attachments: options.attachments.map((attachment) => ({
						FileName: attachment.fileName,
						ContentType: attachment.contentType,
						RawContent: attachment.content,
						ContentTransferEncoding: 'BASE64' as const,
						...(attachment.contentId
							? { ContentDisposition: 'INLINE' as const, ContentId: attachment.contentId }
							: { ContentDisposition: 'ATTACHMENT' as const }),
					})),
				} : {}),
			},
		},
	});

	try {
		const result = await getClient(config.SES_REGION || DEFAULT_SES_REGION).send(command);
		console.log(`Email sent to ${to.join(', ')} (MessageId ${result.MessageId})`);
		return 200;
	} catch (error) {
		const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
		throw new Error('Error sending email: ' + detail);
	}
}

// Function to send reply notification emails
export async function sendReplyNotification(
	toEmail: string,
	replyAuthor: string,
	contentType: 'post' | 'comment' | 'gallery',
	contentSnippet: string,
	contentUrl: string,
	config: EmailConfig
): Promise<number> {
	const subject = `New Reply from ${replyAuthor} on Comms Scribe`;
	
	let contentTypeStr = 'content';
	switch (contentType) {
		case 'post':
			contentTypeStr = 'blog post';
			break;
		case 'comment':
			contentTypeStr = 'comment';
			break;
		case 'gallery':
			contentTypeStr = 'gallery item';
			break;
	}
	
	const message = `
Hello,

${replyAuthor} has replied to your ${contentTypeStr} on Comms Scribe.

Their reply:
"${contentSnippet}"

Click here to view the reply:
${contentUrl}

If you don't want to receive these notifications in the future, you can update your settings in your account preferences.

Thank you,
Comms Scribe Team
	`;
	
	return await sendEmail(toEmail, subject, message, config);
}

// Function to send new group content notification emails
export async function sendGroupContentNotification(
	toEmail: string,
	authorName: string,
	groupName: string,
	contentType: 'post' | 'gallery',
	contentTitle: string,
	contentSnippet: string,
	contentUrl: string,
	config: EmailConfig
): Promise<number> {
	const contentTypeStr = contentType === 'post' ? 'blog post' : 'gallery item';
	const subject = `New ${contentTypeStr} in ${groupName} on Comms Scribe`;
	
	const message = `
Hello,

${authorName} has posted a new ${contentTypeStr} in the ${groupName} group on Comms Scribe.

${contentTitle ? `Title: ${contentTitle}` : ''}

${contentSnippet ? `Preview: "${contentSnippet}"` : ''}

Click here to view the content:
${contentUrl}

If you don't want to receive these notifications in the future, you can update your settings in your account preferences.

Thank you,
Comms Scribe Team
	`;
	
	return await sendEmail(toEmail, subject, message, config);
}

/**
 * Where a comms email (to mailing lists, or an approval reminder) actually goes: the real
 * recipients, or only COMMS_EMAIL_OVERRIDE (dev and staging), with the real recipients named in
 * the subject so the test copy says who it was for.
 */
export function commsRecipients(
	to: string[],
	subject: string,
	config: { COMMS_EMAIL_OVERRIDE?: string },
): { to: string[]; subject: string; redirected: boolean } {
	const override = (config.COMMS_EMAIL_OVERRIDE || '').trim();
	if (!override) return { to, subject, redirected: false };
	return { to: [override], subject: `[for ${to.join(', ')}] ${subject}`, redirected: true };
}
