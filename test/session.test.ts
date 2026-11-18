import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileHost } from '../src/session.ts';

test('fileHost: Notion hosts get the profile cookies, S3 carries its own signature, anything else is refused', () => {
  for (const url of [
    'https://file.notion.com/f/f/1/x.png?signature=1',
    'https://www.notion.so/image/attachment%3Auuid%3Ax.png',
    'https://prod.notionusercontent.com/x.png',
  ]) assert.equal(fileHost(url), 'notion', url);

  for (const url of [
    'https://prod-files-secure.s3.us-west-2.amazonaws.com/a/b/c.png?X-Amz-Signature=1',
    'https://s3.amazonaws.com/x',
  ]) assert.equal(fileHost(url), 's3', url);

  for (const url of [
    'https://evil.example.com/x',
    'https://notion.com.evil.example.com/x',
    'https://amazonaws.com/x',
    'http://file.notion.com/x',
  ]) assert.equal(fileHost(url), undefined, url);
});
