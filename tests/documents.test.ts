/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeDocument } from '../src/documents.ts';
import { temporaryDirectory } from './temporary-directory.ts';

test('DOCX is a valid standard ZIP/OOXML package with intact Unicode text and relationships', async t => {
  const root = await temporaryDirectory(t), target = join(root, 'independent-reader.docx');
  const title = '独立检查 <标题> & "quoted" 😀', paragraphs = ['第一段 & <tag> should remain text.', '两行\n第二行', 'Windows\r\n第二行', 'Legacy\r第二行', '  preserve spaces  '];
  await writeFile(target, makeDocument('docx', title, paragraphs));
  // System.IO.Compression and System.Xml are independent platform readers, not the
  // producer's CRC/header code. Parse every XML part with DTDs and external resolution disabled.
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [System.IO.Compression.ZipFile]::OpenRead($env:COMPUTER_DOCX_FIXTURE)
try {
  $docs = @{}
  $names = @()
  foreach ($entry in $archive.Entries) {
    if ($docs.ContainsKey($entry.FullName)) { throw 'Duplicate ZIP entry' }
    $names += $entry.FullName
    $stream = $entry.Open()
    try {
      $settings = New-Object System.Xml.XmlReaderSettings
      $settings.DtdProcessing = [System.Xml.DtdProcessing]::Prohibit
      $settings.XmlResolver = $null
      $reader = [System.Xml.XmlReader]::Create($stream, $settings)
      try {
        $doc = New-Object System.Xml.XmlDocument
        $doc.XmlResolver = $null
        $doc.Load($reader)
        $docs[$entry.FullName] = $doc
      } finally { $reader.Dispose() }
    } finally { $stream.Dispose() }
  }
  $main = $docs['word/document.xml']
  $ns = New-Object System.Xml.XmlNamespaceManager($main.NameTable)
  $ns.AddNamespace('w', 'http://schemas.openxmlformats.org/wordprocessingml/2006/main')
  $paragraphs = @()
  foreach ($paragraph in $main.SelectNodes('/w:document/w:body/w:p', $ns)) {
    $pieces = @()
    foreach ($piece in $paragraph.SelectNodes('.//w:t | .//w:br', $ns)) {
      if ($piece.LocalName -eq 'br') { $pieces += [string][char]10 } else { $pieces += $piece.InnerText }
    }
    $paragraphs += ($pieces -join '')
  }
  $relationships = @($docs['_rels/.rels'].DocumentElement.ChildNodes | ForEach-Object { @{ target = $_.Target; type = $_.Type } })
  $styleRelationships = @($docs['word/_rels/document.xml.rels'].DocumentElement.ChildNodes | ForEach-Object { @{ target = $_.Target; type = $_.Type } })
  $titleStyle = $main.SelectSingleNode('/w:document/w:body/w:p[1]/w:pPr/w:pStyle', $ns).GetAttribute('val', $ns.LookupNamespace('w'))
  $page = $main.SelectSingleNode('/w:document/w:body/w:sectPr/w:pgSz', $ns)
  $result = @{ names = $names; paragraphs = $paragraphs; relationships = $relationships; styleRelationships = $styleRelationships; titleStyle = $titleStyle; pageWidth = $page.GetAttribute('w', $ns.LookupNamespace('w')); pageHeight = $page.GetAttribute('h', $ns.LookupNamespace('w')); contentTypes = $docs['[Content_Types].xml'].OuterXml }
  $json = ConvertTo-Json -InputObject $result -Depth 8 -Compress
  [Console]::WriteLine([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json)))
} finally { $archive.Dispose() }
`;
  const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const checked = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024,
    env: { ...process.env, COMPUTER_DOCX_FIXTURE: target },
  });
  assert.equal(checked.status, 0, checked.stderr || checked.error?.message);
  const parsed = JSON.parse(Buffer.from(checked.stdout.trim(), 'base64').toString('utf8'));
  assert.deepEqual([...parsed.names].sort(), ['[Content_Types].xml', '_rels/.rels', 'word/_rels/document.xml.rels', 'word/document.xml', 'word/styles.xml'].sort());
  assert.deepEqual(parsed.paragraphs, [title, ...paragraphs.map(text => text.replace(/\r\n?/g, '\n'))]);
  assert.equal(parsed.relationships[0].target, 'word/document.xml');
  assert.match(parsed.relationships[0].type, /\/officeDocument$/);
  assert.equal(parsed.styleRelationships[0].target, 'styles.xml');
  assert.match(parsed.styleRelationships[0].type, /\/styles$/);
  assert.equal(parsed.titleStyle, 'Title');
  assert.equal(parsed.pageWidth, '11906');
  assert.equal(parsed.pageHeight, '16838');
  assert.match(parsed.contentTypes, /wordprocessingml\.document\.main\+xml/);
});

test('HTML output escapes active content while preserving readable document text', () => {
  const html = makeDocument('html', '<script>alert("fixture")</script>', ['<img src=x onerror=alert(1)> & literal', 'first\r\nsecond']).toString('utf8');
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('<img src='));
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt; &amp; literal/);
  assert.match(html, /<p>first\nsecond<\/p>/);
});

test('Markdown retains Unicode paragraphs and prevents a newline from breaking the title heading', () => {
  const markdown = makeDocument('md', '标题\r\ncontinued', ['第一段 😀', '第二段']).toString('utf8');
  assert.equal(markdown, '# 标题 continued\n\n第一段 😀\n\n第二段\n');
});

test('invalid XML characters and oversized document contents are rejected before generation', () => {
  for (const format of ['docx', 'html', 'md'] as const) {
    assert.throws(() => makeDocument(format, 'bad\u0000title', ['ok']), { code: 'document' });
    assert.throws(() => makeDocument(format, 'ok', ['bad\ufffeparagraph']), { code: 'document' });
    assert.throws(() => makeDocument(format, 'ok', ['x'.repeat(512001)]), { code: 'document' });
  }
});
