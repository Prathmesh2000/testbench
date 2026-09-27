import type { Channel, NotifyEvent, RuleBody } from '@tb/contracts';

// Built-in rules and templates. A tenant starts with these; editing one in the console stores an
// override, and "reset" deletes the override so the default applies again.

export const DEFAULT_RULES: RuleBody[] = [
  {
    name: 'Run items assigned to me',
    event: 'run.assigned',
    condition: '',
    userChannels: ['inapp'],
    teamChannels: [],
    fallbackMinutes: 15,
    enabled: true,
  },
  {
    name: 'Bug fixed, retest needed',
    event: 'defect.fixed',
    condition: '',
    userChannels: ['inapp', 'email'],
    teamChannels: ['slack'],
    fallbackMinutes: null,
    enabled: true,
  },
  {
    name: 'Release blocker logged',
    event: 'defect.logged',
    condition: 'severity IN (Blocker, Critical)',
    userChannels: [],
    teamChannels: ['slack', 'teams', 'sms'],
    fallbackMinutes: null,
    enabled: true,
  },
  {
    name: 'New matches for my filters',
    event: 'filter.matched',
    condition: '',
    userChannels: ['inapp'],
    teamChannels: [],
    fallbackMinutes: null,
    enabled: true,
  },
  {
    name: 'My cases need review after a PRD change',
    event: 'requirement.changed',
    condition: '',
    userChannels: ['inapp', 'email'],
    teamChannels: [],
    fallbackMinutes: null,
    enabled: true,
  },
  {
    name: 'Channel test',
    event: 'test.message',
    condition: '',
    userChannels: ['inapp', 'email'],
    teamChannels: [],
    fallbackMinutes: null,
    enabled: true,
  },
];

interface TemplateText {
  subject: string;
  body: string;
}

/** Title (subject) and body per event. The same text is used for every channel unless overridden. */
const TEXT: Record<NotifyEvent, TemplateText> = {
  'run.assigned': {
    subject: '{{count}} items assigned to you in {{runKey}}',
    body: '{{runName}} on build {{build}} is ready for you.',
  },
  'defect.logged': {
    subject: '{{severity}} bug {{jiraKey}}: {{summary}}',
    body: 'Logged by {{reporter}} from a failed run item.',
  },
  'defect.fixed': { subject: '{{jiraKey}} is fixed; retest needed', body: '{{summary}}. Retest: {{cases}}.' },
  'filter.matched': { subject: 'New case in “{{filterName}}”', body: '{{caseKey}} {{caseTitle}}' },
  'requirement.changed': {
    subject: '{{count}} of your cases need review',
    body: '{{documentTitle}} v{{version}} changed requirements they cover. They still run, with a warning, until you confirm or update them.',
  },
  'test.message': {
    subject: 'Testbench test notification',
    body: 'Sent by {{sentBy}} from the notification console. If you can read this, the channel works.',
  },
};

export function defaultTemplate(event: NotifyEvent, _channel: Channel): TemplateText {
  return TEXT[event];
}
