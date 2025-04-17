import { AwsClient } from "aws4fetch";

export async function sendEmail(
	toEmail: string, 
	subjectLine: string, 
	message: string,
	IAM_ACCESS_KEY: string, 
	IAM_ACCESS_KEY_SECRET: string): Promise<number> {
	const aws: AwsClient = new AwsClient({ accessKeyId: IAM_ACCESS_KEY, secretAccessKey: IAM_ACCESS_KEY_SECRET });
	let resp = await aws.fetch('https://email.us-east-1.amazonaws.com/v2/email/outbound-emails', {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
		},
		body: JSON.stringify({
			Destination: 
			{
				ToAddresses: [ toEmail ],
				BccAddresses: [ 'alexander.young@gmail.com' ],
			},
			FromEmailAddress: 'Dancing Cats <alex@dancingcats.org>',
			Content: {
				Simple: {
					Subject: {
						Data: subjectLine
					},
					Body: {
						Text: {
							Data: message.replace(/<br\s*[\/]?>/gi, "\n"),
						},
						Html: {
							Data: `
							<body>
								<div align="center" style="font-family:Calibri, Arial, Helvetica, sans-serif;">
									<table width="600" cellpadding="0" cellspacing="0" border="0" style="font-family:Calibri, Arial, Helvetica, sans-serif">
									<tr style="background-color:white;"><td><table width="600" cellpadding="0">
									<tr>
									<td>
									<h1>Dancing Cats</h1>
									<p>` + message.replace(/\n/g, '<br>') +`
									</p></td></tr></table></td></tr></table></div></body>`,
						}
					}
				},
			},
		}),
	});

	const respText = await resp.json();
	console.log(resp.status + " " + resp.statusText);
	console.log(respText);
	if (resp.status != 200 && resp.status != 201) {
		throw new Error('Error sending email: ' + resp.status + " " + resp.statusText + " " + respText);
	}
	return resp.status;
}

// Function to send reply notification emails
export async function sendReplyNotification(
	toEmail: string,
	replyAuthor: string,
	contentType: 'post' | 'comment' | 'gallery',
	contentSnippet: string,
	contentUrl: string,
	IAM_ACCESS_KEY: string,
	IAM_ACCESS_KEY_SECRET: string
): Promise<number> {
	const subject = `New Reply from ${replyAuthor} on Dancing Cats`;
	
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

${replyAuthor} has replied to your ${contentTypeStr} on Dancing Cats.

Their reply:
"${contentSnippet}"

Click here to view the reply:
${contentUrl}

If you don't want to receive these notifications in the future, you can update your settings in your account preferences.

Thank you,
Dancing Cats Team
	`;
	
	return await sendEmail(toEmail, subject, message, IAM_ACCESS_KEY, IAM_ACCESS_KEY_SECRET);
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
	IAM_ACCESS_KEY: string,
	IAM_ACCESS_KEY_SECRET: string
): Promise<number> {
	const contentTypeStr = contentType === 'post' ? 'blog post' : 'gallery item';
	const subject = `New ${contentTypeStr} in ${groupName} on Dancing Cats`;
	
	const message = `
Hello,

${authorName} has posted a new ${contentTypeStr} in the ${groupName} group on Dancing Cats.

${contentTitle ? `Title: ${contentTitle}` : ''}

${contentSnippet ? `Preview: "${contentSnippet}"` : ''}

Click here to view the content:
${contentUrl}

If you don't want to receive these notifications in the future, you can update your settings in your account preferences.

Thank you,
Dancing Cats Team
	`;
	
	return await sendEmail(toEmail, subject, message, IAM_ACCESS_KEY, IAM_ACCESS_KEY_SECRET);
}
