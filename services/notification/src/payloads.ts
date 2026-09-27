// Request bodies for each team channel's webhook format. Pure, so the exact shape each provider
// receives is covered by tests.

export interface Message {
  title: string;
  body: string;
  link?: string;
}

/** Slack incoming webhook: `text` is the notification fallback, blocks are what people see. */
export function slackPayload(m: Message) {
  return {
    text: m.title,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: `*${m.title}*\n${m.body}` } },
      ...(m.link
        ? [
            {
              type: 'actions',
              elements: [
                { type: 'button', text: { type: 'plain_text', text: 'Open in Testbench' }, url: m.link },
              ],
            },
          ]
        : []),
    ],
  };
}

/**
 * Microsoft Teams via a Workflows webhook (the old Office 365 connectors are retired, HLD §5.7):
 * an Adaptive Card wrapped in a message attachment.
 */
export function teamsPayload(m: Message) {
  return {
    type: 'message',
    attachments: [
      {
        contentType: 'application/vnd.microsoft.card.adaptive',
        content: {
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
          type: 'AdaptiveCard',
          version: '1.4',
          body: [
            { type: 'TextBlock', text: m.title, weight: 'Bolder', wrap: true },
            { type: 'TextBlock', text: m.body, wrap: true },
          ],
          ...(m.link && { actions: [{ type: 'Action.OpenUrl', title: 'Open in Testbench', url: m.link }] }),
        },
      },
    ],
  };
}

/** Discord webhook: one embed; content stays empty so the embed is the whole message. */
export function discordPayload(m: Message) {
  return {
    embeds: [
      {
        title: m.title.slice(0, 256),
        description: m.body.slice(0, 4000),
        ...(m.link && { url: m.link }),
        color: 0x4c8dff,
      },
    ],
  };
}

/** SMS: title and link only; 160 characters is a single segment, which keeps costs predictable. */
export function smsText(m: Message): string {
  const text = m.link ? `${m.title} ${m.link}` : m.title;
  return text.length <= 160
    ? text
    : `${m.title.slice(0, 157 - (m.link ? m.link.length + 1 : 0))}…${m.link ? ` ${m.link}` : ''}`;
}
