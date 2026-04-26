import assert from 'node:assert/strict';
import {
  normalizeSlackEventPayload,
  validateSlackEventPayloadForWrite,
  type SlackEventPayload,
} from '../lib/slack/payload-normalizer';

type TestCase = {
  name: string;
  payload: SlackEventPayload;
  expectWritable: boolean;
  expectedEventType: string;
  expectedPayloadType: string;
  expectedEventId: string | null;
  expectedWorkspaceId: string | null;
  expectedChannelId: string | null;
  expectedSlackUserId: string | null;
};

const cases: TestCase[] = [
  {
    name: 'url_verification',
    payload: {
      type: 'url_verification',
      challenge: 'challenge-token',
    },
    expectWritable: false,
    expectedEventType: 'url_verification',
    expectedPayloadType: 'url_verification',
    expectedEventId: null,
    expectedWorkspaceId: null,
    expectedChannelId: null,
    expectedSlackUserId: null,
  },
  {
    name: 'event_callback + message',
    payload: {
      type: 'event_callback',
      event_id: 'Ev123',
      team_id: 'T123',
      event: {
        type: 'message',
        channel: 'C123',
        user: 'U123',
      },
    },
    expectWritable: true,
    expectedEventType: 'message',
    expectedPayloadType: 'event_callback',
    expectedEventId: 'Ev123',
    expectedWorkspaceId: 'T123',
    expectedChannelId: 'C123',
    expectedSlackUserId: 'U123',
  },
  {
    name: 'event_callback without event',
    payload: {
      type: 'event_callback',
      event_id: 'Ev124',
      team_id: 'T123',
    },
    expectWritable: false,
    expectedEventType: 'event_callback',
    expectedPayloadType: 'event_callback',
    expectedEventId: 'Ev124',
    expectedWorkspaceId: 'T123',
    expectedChannelId: null,
    expectedSlackUserId: null,
  },
  {
    name: 'event_id missing',
    payload: {
      type: 'event_callback',
      team_id: 'T123',
      event: {
        type: 'message',
        channel: 'C123',
        user: 'U123',
      },
    },
    expectWritable: false,
    expectedEventType: 'message',
    expectedPayloadType: 'event_callback',
    expectedEventId: null,
    expectedWorkspaceId: 'T123',
    expectedChannelId: 'C123',
    expectedSlackUserId: 'U123',
  },
  {
    name: 'team_id missing but authorizations fallback',
    payload: {
      type: 'event_callback',
      event_id: 'Ev125',
      authorizations: [{ team_id: 'T999' }],
      event: {
        type: 'message',
        channel: 'C123',
        user: 'U123',
      },
    },
    expectWritable: true,
    expectedEventType: 'message',
    expectedPayloadType: 'event_callback',
    expectedEventId: 'Ev125',
    expectedWorkspaceId: 'T999',
    expectedChannelId: 'C123',
    expectedSlackUserId: 'U123',
  },
  {
    name: 'channel missing',
    payload: {
      type: 'event_callback',
      event_id: 'Ev126',
      team_id: 'T123',
      event: {
        type: 'message',
        user: 'U123',
      },
    },
    expectWritable: false,
    expectedEventType: 'message',
    expectedPayloadType: 'event_callback',
    expectedEventId: 'Ev126',
    expectedWorkspaceId: 'T123',
    expectedChannelId: null,
    expectedSlackUserId: 'U123',
  },
  {
    name: 'user missing',
    payload: {
      type: 'event_callback',
      event_id: 'Ev127',
      team_id: 'T123',
      event: {
        type: 'message',
        channel: 'C123',
      },
    },
    expectWritable: true,
    expectedEventType: 'message',
    expectedPayloadType: 'event_callback',
    expectedEventId: 'Ev127',
    expectedWorkspaceId: 'T123',
    expectedChannelId: 'C123',
    expectedSlackUserId: null,
  },
];

for (const testCase of cases) {
  const normalized = normalizeSlackEventPayload(testCase.payload);
  const validation = validateSlackEventPayloadForWrite(normalized);

  assert.equal(normalized.eventType, testCase.expectedEventType, `${testCase.name}: eventType`);
  assert.equal(normalized.payloadType, testCase.expectedPayloadType, `${testCase.name}: payloadType`);
  assert.equal(normalized.eventId, testCase.expectedEventId, `${testCase.name}: eventId`);
  assert.equal(normalized.workspaceId, testCase.expectedWorkspaceId, `${testCase.name}: workspaceId`);
  assert.equal(normalized.channelId, testCase.expectedChannelId, `${testCase.name}: channelId`);
  assert.equal(normalized.slackUserId, testCase.expectedSlackUserId, `${testCase.name}: slackUserId`);
  assert.notEqual(normalized.eventType, null, `${testCase.name}: eventType must not be null`);
  assert.notEqual(normalized.payloadType, null, `${testCase.name}: payloadType must not be null`);
  assert.equal(validation.ok, testCase.expectWritable, `${testCase.name}: writable`);
  if (!testCase.expectWritable) {
    assert.ok(validation.missingFields.length > 0, `${testCase.name}: missingFields`);
  }
}

console.log(`verified ${cases.length} slack payload normalization cases`);
