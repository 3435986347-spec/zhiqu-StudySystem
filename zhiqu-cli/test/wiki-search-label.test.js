// search_wiki 第四十五轮起认页面类型（服务端 WikiPageTypes）：用户问「我有哪些目标」，模型会只给 type、不给关键词。
// 原来这一行写死成「查知识库「${args.query}」」—— 只给类型时屏幕上是「查知识库「undefined」」。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeCall, wikiSearchLabel } from '../src/agent.js';

test('search_wiki：只给类型时说查哪一类，不出 undefined', () => {
  assert.equal(describeCall('search_wiki', { type: 'GOAL' }), '查知识库里的目标页');
  assert.equal(describeCall('search_wiki', { type: '计划' }), '查知识库里的计划页');
  assert.equal(describeCall('search_wiki', {}), '列出知识库的页面');
  assert.ok(!describeCall('search_wiki', { type: 'goal' }).includes('undefined'));
});

test('search_wiki：给了关键词照旧，带类型时补一句', () => {
  assert.equal(wikiSearchLabel({ query: '周报' }), '查知识库「周报」');
  assert.equal(wikiSearchLabel({ query: '考研', type: 'GOAL' }), '查知识库「考研」（目标页）');
});
