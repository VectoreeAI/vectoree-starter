import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildChatMessages,
  imageDataUrl,
  parseModelList,
  pickDefaultModel,
  pickImageModel,
  readSessionTokens,
  toClientAuthBody,
} from './vectoree.js';

describe('models', () => {
  it('prefers the first vision model that still returns text', () => {
    const models = parseModelList({
      object: 'list',
      data: [
        { id: 'alibaba/wan-3.0', inputModality: ['text'], outputModality: ['video'] },
        { id: 'vendor/vision', name: 'Vision', inputModality: ['text', 'image'], outputModality: ['text'] },
        { id: 'vendor/chat', inputModality: ['text'], outputModality: ['text'] },
      ],
    });
    assert.equal(pickDefaultModel(models), 'vendor/vision');
    assert.equal(models[1]?.vision, true);
    assert.equal(models[0]?.vision, false);
  });

  it('falls back to vectoree/auto when the catalog is empty', () => {
    assert.equal(pickDefaultModel([]), 'vectoree/auto');
  });

  it('picks the first image-output model and ignores vision-only chat models', () => {
    const models = parseModelList({
      data: [
        { id: 'vendor/vision', inputModality: ['text', 'image'], outputModality: ['text'] },
        { id: 'vendor/omni', outputModality: ['Text', 'Image'] },
        { id: 'vendor/paint', outputModality: ['IMAGE'] },
        {
          id: 'vendor/poster',
          architecture: { input_modalities: ['text'], output_modalities: ['image'] },
        },
      ],
    });
    assert.equal(models[0]?.imageOutput, false);
    assert.equal(models[1]?.imageOutput, false);
    assert.equal(models[2]?.imageOutput, true);
    assert.equal(pickImageModel(models), 'vendor/paint');
    assert.equal(pickDefaultModel(models), 'vendor/vision');
  });

  it('prefers grok imagine, and a quality id when several grok imagine models exist', () => {
    const wanFirst = parseModelList({
      data: [
        { id: 'alibaba/wan-2.6', outputModality: ['image'] },
        { id: 'x-ai/grok-imagine-image-2.0', outputModality: ['image'] },
      ],
    });
    assert.equal(pickImageModel(wanFirst), 'x-ai/grok-imagine-image-2.0');

    const qualityLater = parseModelList({
      data: [
        { id: 'alibaba/wan-2.6', outputModality: ['image'] },
        { id: 'x-ai/grok-imagine-image-2.0', outputModality: ['image'] },
        { id: 'X-AI/Grok-Imagine-Image-Quality', outputModality: ['image'] },
      ],
    });
    assert.equal(pickImageModel(qualityLater), 'X-AI/Grok-Imagine-Image-Quality');
  });

  it('falls back to the first image model when grok imagine is absent', () => {
    const models = parseModelList({
      data: [{ id: 'alibaba/wan-2.6', outputModality: ['image'] }],
    });
    assert.equal(pickImageModel(models), 'alibaba/wan-2.6');
    assert.equal(pickImageModel([]), null);
  });

  it('reads OpenRouter-style architecture modalities', () => {
    const models = parseModelList({
      data: [
        {
          id: 'vendor/eyes',
          architecture: { input_modalities: ['image', 'text'], output_modalities: ['text'] },
        },
      ],
    });
    assert.equal(models[0]?.vision, true);
  });
});

describe('chat parts', () => {
  it('forwards an image as an image_url data URL', () => {
    const messages = buildChatMessages([
      {
        role: 'user',
        content: 'What is this?',
        image: { mediaType: 'image/png', data: 'aGVsbG8=' },
      },
    ]);
    assert.deepEqual(messages[0]?.content, [
      { type: 'text', text: 'What is this?' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } },
    ]);
  });

  it('rejects remote image URLs', () => {
    assert.throws(() => imageDataUrl({ mediaType: 'image/png', data: 'https://example.com/a.png' }));
  });
});

describe('auth client body', () => {
  it('strips tokens and keeps the public user', () => {
    const result = toClientAuthBody(200, {
      accessToken: 'eyJ.app',
      refreshToken: 'refresh-secret',
      user: { id: 'user-1', email: 'a@example.com', profile: { name: 'Ada' } },
    });
    assert.equal(result.httpStatus, 200);
    assert.deepEqual(result.body, { user: { id: 'user-1', email: 'a@example.com', name: 'Ada' } });
    assert.equal(JSON.stringify(result.body).includes('eyJ'), false);
    assert.equal(JSON.stringify(result.body).includes('refresh-secret'), false);
    assert.ok(readSessionTokens({ accessToken: 'eyJ.app', refreshToken: 'refresh-secret' }));
  });

  it('asks for the 8-digit code when login is unverified', () => {
    const result = toClientAuthBody(403, {
      error: 'AUTH_NEED_VERIFICATION',
      message: 'Email verification required',
      statusCode: 403,
    });
    assert.equal(result.httpStatus, 200);
    assert.equal(result.body.user, null);
    assert.equal('requireEmailVerification' in result.body && result.body.requireEmailVerification, true);
  });

  it('does not treat signup-disabled as a verification prompt', () => {
    const result = toClientAuthBody(403, {
      error: 'AUTH_SIGNUP_DISABLED',
      message: 'User signups are disabled for this project.',
      statusCode: 403,
    });
    assert.equal(result.httpStatus, 403);
    assert.equal('requireEmailVerification' in result.body, false);
  });
});
