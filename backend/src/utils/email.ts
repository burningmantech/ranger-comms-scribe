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

/**
 * Send an email through SES v2. Returns 200 on success (callers used to receive
 * the HTTP status) and throws on failure.
 */
export async function sendEmail(
	toEmail: string,
	subjectLine: string,
	message: string,
	config: EmailConfig): Promise<number> {
	const bcc = (config.EMAIL_BCC || []).filter((address) => address.length > 0);
	const command = new SendEmailCommand({
		FromEmailAddress: config.EMAIL_FROM || DEFAULT_EMAIL_FROM,
		Destination: {
			ToAddresses: [ toEmail ],
			...(bcc.length > 0 ? { BccAddresses: bcc } : {}),
		},
		Content: {
			Simple: {
				Subject: { Data: subjectLine },
				Body: {
					Text: { Data: renderEmailText(message) },
					Html: { Data: renderEmailHtml(message) },
				},
			},
		},
	});

	try {
		const result = await getClient(config.SES_REGION || DEFAULT_SES_REGION).send(command);
		console.log(`Email sent to ${toEmail} (MessageId ${result.MessageId})`);
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
