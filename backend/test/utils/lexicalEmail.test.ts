import * as fs from 'fs';
import * as path from 'path';
import { renderContentForEmail, parseLexical, safeUrl, TEXT_FORMAT } from '../../src/utils/lexicalEmail';

const PUBLIC_URL = 'https://scribe.example.org/api';

// Lexical node builders (the serialized shapes the editor exports)
const text = (value: string, format = 0, style = '') =>
  ({ type: 'text', version: 1, detail: 0, format, mode: 'normal', style, text: value });
const linebreak = () => ({ type: 'linebreak', version: 1 });
const paragraph = (...children: any[]) =>
  ({ type: 'paragraph', version: 1, direction: null, format: '', indent: 0, textFormat: 0, children });
const heading = (tag: string, ...children: any[]) =>
  ({ type: 'heading', version: 1, direction: null, format: '', indent: 0, tag, children });
const quote = (...children: any[]) => ({ type: 'quote', version: 1, direction: null, format: '', indent: 0, children });
const listItem = (children: any[], extra: Record<string, unknown> = {}) =>
  ({ type: 'listitem', version: 1, direction: null, format: '', indent: 0, value: 1, children, ...extra });
const list = (listType: 'bullet' | 'number' | 'check', items: any[], start = 1) =>
  ({ type: 'list', version: 1, direction: null, format: '', indent: 0, listType, start, tag: listType === 'number' ? 'ol' : 'ul', children: items });
const link = (url: string, ...children: any[]) =>
  ({ type: 'link', version: 1, direction: null, format: '', indent: 0, rel: 'noreferrer', target: null, title: null, url, children });
const image = (extra: Record<string, unknown>) => ({
  type: 'image', version: 1, direction: null, format: '', indent: 0, children: [],
  src: '/api/gallery/1791242299248_pasted-image.png', altText: '', width: 513, height: 222, alignment: 'none',
  ...extra,
});
const cell = (children: any[], headerState = 0) =>
  ({ type: 'tablecell', version: 1, direction: null, format: '', indent: 0, headerState, colSpan: 1, rowSpan: 1, backgroundColor: null, children });
const row = (...cells: any[]) => ({ type: 'tablerow', version: 1, direction: null, format: '', indent: 0, children: cells });
const table = (...rows: any[]) => ({ type: 'table', version: 1, direction: null, format: '', indent: 0, children: rows });
const deletedText = (deleted: string) => ({
  type: 'deleted-text', version: 1, changeId: 'change-1', deletedText: deleted, authorName: 'Reviewer',
  authorColor: '#607d8b', isBlockLevel: false,
});

const doc = (...children: any[]) => JSON.stringify({
  root: { type: 'root', version: 1, direction: null, format: '', indent: 0, children },
});

const render = (...children: any[]) => renderContentForEmail(doc(...children), { publicUrl: PUBLIC_URL });

describe('renderContentForEmail (Lexical JSON)', () => {
  it('renders paragraphs with inline styles and never the raw JSON', () => {
    const { html, text: plain } = render(paragraph(text('Hello')), paragraph(), paragraph(text('World')));
    expect(html).toBe(
      '<p style="margin:0;">Hello</p><p style="margin:0;">&nbsp;</p><p style="margin:0;">World</p>'
    );
    expect(html).not.toContain('{"root"');
    expect(plain).toBe('Hello\n\nWorld');
  });

  it('applies every text format bit', () => {
    const cases: Array<[number, string]> = [
      [TEXT_FORMAT.bold, '<strong>x</strong>'],
      [TEXT_FORMAT.italic, '<em>x</em>'],
      [TEXT_FORMAT.strikethrough, '<s>x</s>'],
      [TEXT_FORMAT.underline, '<u>x</u>'],
      [TEXT_FORMAT.subscript, '<sub>x</sub>'],
      [TEXT_FORMAT.superscript, '<sup>x</sup>'],
    ];
    for (const [format, expected] of cases) {
      expect(render(paragraph(text('x', format))).html).toContain(expected);
    }
    expect(render(paragraph(text('x', TEXT_FORMAT.code))).html).toMatch(/<code style="[^"]*monospace[^"]*">x<\/code>/);
    // Combined: bold + italic + underline
    const combined = render(paragraph(text('x', TEXT_FORMAT.bold | TEXT_FORMAT.italic | TEXT_FORMAT.underline))).html;
    expect(combined).toContain('<u><em><strong>x</strong></em></u>');
  });

  it('keeps safe colours and drops other inline styles', () => {
    const { html } = render(paragraph(text('red', 0, 'color: #cc0000; position: fixed; background-image: url(x)')));
    expect(html).toContain('<span style="color:#cc0000;">red</span>');
    expect(html).not.toContain('position');
    expect(html).not.toContain('url(');
  });

  it('renders linebreaks, with the extra <br> Lexical adds after a trailing one', () => {
    const { html, text: plain } = render(paragraph(text('a'), linebreak(), text('b')), paragraph(linebreak(), linebreak()));
    expect(html).toContain('<p style="margin:0;">a<br>b</p>');
    expect(html).toContain('<p style="margin:0;"><br><br><br></p>');
    expect(plain).toBe('a\nb'); // trailing blank lines trimmed
  });

  it('renders headings h1-h6 and quotes', () => {
    for (const tag of ['h1', 'h2', 'h3', 'h4', 'h5', 'h6']) {
      expect(render(heading(tag, text('Title'))).html).toMatch(new RegExp(`^<${tag} style="[^"]*font-weight:bold;[^"]*">Title</${tag}>$`));
    }
    expect(render(heading('script', text('x'))).html).toMatch(/^<h2 /);
    const { html, text: plain } = render(quote(text('Quoted')));
    expect(html).toMatch(/^<blockquote style="[^"]*border-left:4px solid[^"]*">Quoted<\/blockquote>$/);
    expect(plain).toBe('> Quoted');
  });

  it('renders paragraph alignment and indent', () => {
    const centered = { ...paragraph(text('c')), format: 'center', indent: 2 };
    expect(render(centered).html).toBe('<p style="margin:0;text-align:center;padding-left:80px;">c</p>');
  });

  it('renders bullet, numbered and check lists, including nested lists', () => {
    const nested = list('bullet', [
      listItem([text('One')]),
      listItem([list('bullet', [listItem([text('One A')], { indent: 1 }), listItem([text('One B')], { indent: 1 })])]),
      listItem([text('Two')]),
    ]);
    const { html, text: plain } = render(nested);
    expect(html).toBe(
      '<ul style="margin:0 0 4px 0;padding-left:28px;">'
      + '<li style="margin:0 0 2px 0;">One</li>'
      + '<li style="list-style-type:none;margin:0;"><ul style="margin:0 0 4px 0;padding-left:28px;">'
      + '<li style="margin:0 0 2px 0;">One A</li><li style="margin:0 0 2px 0;">One B</li></ul></li>'
      + '<li style="margin:0 0 2px 0;">Two</li></ul>'
    );
    expect(plain).toBe('- One\n  - One A\n  - One B\n- Two');

    const numbered = render(list('number', [listItem([text('First')]), listItem([text('Second')])], 3));
    expect(numbered.html).toMatch(/^<ol start="3" style="[^"]*"><li[^>]*>First<\/li><li[^>]*>Second<\/li><\/ol>$/);
    expect(numbered.text).toBe('3. First\n4. Second');

    const checks = render(list('check', [listItem([text('Done')], { checked: true }), listItem([text('Todo')], { checked: false })]));
    expect(checks.html).toContain('list-style-type:none');
    expect(checks.html).toContain('&#9745;&nbsp;Done');
    expect(checks.html).toContain('&#9744;&nbsp;Todo');
    expect(checks.text).toBe('[x] Done\n[ ] Todo');
  });

  it('renders links with safe schemes only', () => {
    const { html, text: plain } = render(paragraph(text('See '), link('https://example.org/a?b=1&c=2', text('the FAQ')), text('.')));
    expect(html).toContain('<a href="https://example.org/a?b=1&amp;c=2" style="color:#1a5fb4;text-decoration:underline;">the FAQ</a>');
    expect(plain).toBe('See the FAQ (https://example.org/a?b=1&c=2).');

    const mail = render(paragraph(link('mailto:rangers@example.org', text('rangers@example.org'))));
    expect(mail.html).toContain('href="mailto:rangers@example.org"');
    expect(mail.text).toBe('rangers@example.org');

    const autolink = render(paragraph({ ...link('https://auto.example.org', text('https://auto.example.org')), type: 'autolink' }));
    expect(autolink.html).toContain('<a href="https://auto.example.org/"');

    for (const bad of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,<script>alert(1)</script>', 'vbscript:x']) {
      const rendered = render(paragraph(link(bad, text('click'))));
      expect(rendered.html).toBe('<p style="margin:0;">click</p>');
    }
  });

  it('makes relative image URLs absolute, caps the width at 600px with height:auto', () => {
    const { html, text: plain } = render(
      image({ altText: 'Ticket page' }),
      image({ src: 'https://cdn.example.org/wide.png', width: 1400, height: 700, alignment: 'center' }),
    );
    expect(html).toContain(
      '<img src="https://scribe.example.org/api/gallery/1791242299248_pasted-image.png" alt="Ticket page" width="513"'
    );
    expect(html).toMatch(/width="600" style="[^"]*max-width:100%;height:auto;width:600px;margin:0 auto;"/);
    expect(html).toContain('text-align:center;');
    expect(plain).toBe('[Image: Ticket page]\n[Image]');
  });

  it('drops image placeholders and unsafe image sources', () => {
    expect(render(image({ pending: true, pendingSince: 1 })).html).toBe('');
    expect(render(image({ src: 'data:image/png;base64,AAAA' })).html).toBe('');
    expect(render(image({ src: 'javascript:alert(1)' })).html).toBe('');
    // Without PUBLIC_URL a relative image can't be made absolute, so it's left out
    expect(renderContentForEmail(doc(image({})), {}).html).toBe('');
  });

  it('renders tables with header cells', () => {
    const { html, text: plain } = render(table(
      row(cell([paragraph(text('Item'))], 1), cell([paragraph(text('Price'))], 1)),
      row(cell([paragraph(text('SPT'))]), cell([paragraph(text('$250'))])),
    ));
    expect(html).toMatch(/^<table role="presentation" [^>]*style="border-collapse:collapse;[^"]*"><tbody><tr>/);
    expect(html).toMatch(/<th style="[^"]*border:1px solid #cccccc;[^"]*font-weight:bold;"><p style="margin:0;">Item<\/p><\/th>/);
    expect(html).toMatch(/<td style="[^"]*"><p style="margin:0;">\$250<\/p><\/td><\/tr><\/tbody><\/table>$/);
    expect(plain).toBe('Item | Price\nSPT | $250');
  });

  it('renders code blocks, horizontal rules, checkboxes and suggestions', () => {
    const code = {
      type: 'code', version: 1, direction: null, format: '', indent: 0, language: 'js',
      children: [{ ...text('const a = 1;'), type: 'code-highlight' }, linebreak(), { ...text('\t'), type: 'tab' }, { ...text('<b>'), type: 'code-highlight' }],
    };
    const codeHtml = render(code).html;
    expect(codeHtml).toMatch(/^<pre style="[^"]*monospace[^"]*white-space:pre-wrap;[^"]*">const a = 1;\n\t&lt;b&gt;<\/pre>$/);

    expect(render({ type: 'horizontalrule', version: 1 }).html).toMatch(/^<hr style="[^"]*">$/);

    const checkbox = { type: 'checkbox', version: 1, direction: null, format: '', indent: 0, checked: true, text: 'Agree', children: [] };
    expect(render(checkbox).html).toBe('<p style="margin:0;">&#9745;&nbsp;Agree</p>');

    const suggestion = (status: string) => ({ type: 'suggestion', version: 1, id: 's', originalText: 'old', suggestedText: 'new', authorId: 'a', status });
    expect(render(paragraph(suggestion('APPROVED'))).text).toBe('new');
    expect(render(paragraph(suggestion('PENDING'))).text).toBe('old');
    expect(render(paragraph(suggestion('REJECTED'))).text).toBe('old');
  });

  it('leaves out deleted-text markers (pending deletions)', () => {
    const { html, text: plain } = render(paragraph(text('Keep this'), deletedText(' but not this'), text('.')));
    expect(html).toBe('<p style="margin:0;">Keep this.</p>');
    expect(plain).toBe('Keep this.');
  });

  it('renders the children of unknown nodes', () => {
    const mark = { type: 'mark', version: 1, ids: ['c1'], children: [text('commented', TEXT_FORMAT.bold)] };
    expect(render(paragraph(text('a '), mark)).html).toBe('<p style="margin:0;">a <strong>commented</strong></p>');
    expect(render({ type: 'mystery-block', children: [paragraph(text('inside'))] }).html).toBe('<p style="margin:0;">inside</p>');
  });

  it('escapes text and attributes', () => {
    const { html } = render(
      paragraph(text('<script>alert("x")</script> & \'quotes\'')),
      image({ altText: '"><script>alert(1)</script>' }),
      paragraph(link('https://example.org/"onmouseover="alert(1)', text('x'))),
    );
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;quotes&#39;');
    expect(html).toContain('alt="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"');
    expect(html).not.toMatch(/"onmouseover=/);
  });

  it('accepts a parsed object and the { editorState } wrapper', () => {
    const state = JSON.parse(doc(paragraph(text('obj'))));
    expect(renderContentForEmail(state).html).toBe('<p style="margin:0;">obj</p>');
    expect(renderContentForEmail(JSON.stringify({ editorState: state })).html).toBe('<p style="margin:0;">obj</p>');
  });
});

describe('renderContentForEmail (not Lexical)', () => {
  it('escapes plain text and turns newlines into <br>', () => {
    const { html, text: plain } = renderContentForEmail('Hi <team> & co\nLine two', { publicUrl: PUBLIC_URL });
    expect(html).toBe('<p style="margin:0;">Hi &lt;team&gt; &amp; co<br>Line two</p>');
    expect(plain).toBe('Hi <team> & co\nLine two');
  });

  it('keeps legacy HTML as HTML, minus scripts, handlers and unsafe URLs, with absolute gallery URLs', () => {
    const legacy = '<p onclick="steal()">Hello <strong>there</strong></p><script>alert(1)</script>'
      + '<img src="/api/gallery/old.png"><a href="javascript:alert(1)">bad</a><a href="https://ok.example.org">ok</a>';
    const { html, text: plain } = renderContentForEmail(legacy, { publicUrl: PUBLIC_URL });
    expect(html).toContain('<p>Hello <strong>there</strong></p>');
    expect(html).toContain('<img src="https://scribe.example.org/api/gallery/old.png">');
    expect(html).toContain('<a>bad</a>');
    expect(html).toContain('<a href="https://ok.example.org/">ok</a>');
    expect(html).not.toMatch(/script|onclick|javascript/i);
    expect(plain).toBe('Hello there\nbadok');
  });

  it('drops SVG, other URL attributes, unsafe styles and unknown tags, and escapes stray brackets', () => {
    const legacy = '<p>Hi</p><svg><a xlink:href="javascript:alert(1)">x</a></svg>'
      + '<img src="https://ok.example.org/a.png" srcset="javascript:alert(1)" onerror="alert(1)">'
      + '<a href="https://ok.example.org" formaction="javascript:x" class="c">ok</a>'
      + '<div style="background:url(javascript:alert(1))">bg</div><span style="color:#c00">red</span>'
      + '<blink>kept text</blink><p>tail <img src=x onerror=alert(1)';
    const { html } = renderContentForEmail(legacy, { publicUrl: PUBLIC_URL });
    expect(html).toBe(
      '<p>Hi</p>'
      + '<img src="https://ok.example.org/a.png">'
      + '<a href="https://ok.example.org/">ok</a>'
      + '<div>bg</div><span style="color:#c00">red</span>'
      + 'kept text<p>tail &lt;img src=x onerror=alert(1)'
    );
  });

  it('treats JSON that is not a Lexical state as text', () => {
    expect(parseLexical('{"foo":1}')).toBeNull();
    expect(renderContentForEmail('{"foo":1}').html).toBe('<p style="margin:0;">{&quot;foo&quot;:1}</p>');
    expect(renderContentForEmail('{"root":').html).toBe('<p style="margin:0;">{&quot;root&quot;:</p>');
  });

  it('renders empty content as empty', () => {
    expect(renderContentForEmail('')).toEqual({ html: '', text: '' });
    expect(renderContentForEmail(undefined)).toEqual({ html: '', text: '' });
  });
});

describe('safeUrl', () => {
  it('resolves root-relative URLs against the PUBLIC_URL origin and rejects others', () => {
    expect(safeUrl('/api/gallery/a.png', ['https:'], PUBLIC_URL)).toBe('https://scribe.example.org/api/gallery/a.png');
    expect(safeUrl('//evil.example.org/a.png', ['https:'], PUBLIC_URL)).toBeNull();
    expect(safeUrl('relative/path.png', ['https:'], PUBLIC_URL)).toBeNull();
    expect(safeUrl('http://x.example.org', ['https:'], PUBLIC_URL)).toBeNull();
  });
});

describe('the dev announcement document (fixture)', () => {
  const fixture = fs.readFileSync(path.join(__dirname, '../fixtures/announcementDocument.json'), 'utf8');

  it('renders formatting, lists, links and the three images with absolute URLs', () => {
    const { html, text: plain } = renderContentForEmail(fixture, { publicUrl: 'https://dev.scrivenly.com/api' });

    expect(html).not.toContain('{"root"');
    expect(html).not.toContain('"type"');
    const images = html.match(/<img [^>]*>/g) || [];
    expect(images).toHaveLength(3);
    for (const img of images) {
      expect(img).toMatch(/^<img src="https:\/\/dev\.scrivenly\.com\/api\/gallery\/\d+_pasted-image-\d+\.png" alt="" width="\d+" style="[^"]*height:auto;/);
    }
    expect(html).toContain('<strong>must</strong>');
    expect(html).toContain('<em>your</em>');
    expect(html).toContain('<a href="https://docs.google.com/document/d/1wuucvq017bQHP7-0uH2KlSWSaYW7CSvNN7siU11Ah7k/edit"');
    expect(html).toContain('<li style="list-style-type:none;margin:0;"><ul'); // nested list
    expect(html).toContain('<p style="margin:0;"><br><br><br></p>'); // the linebreak paragraph
    expect(html).toContain('Tickets &amp; Stuff');

    expect(plain).toContain('Rangers — Ticketing Team');
    expect(plain).toContain('  - Rangers who claim a Staff Credential (SC) can claim a Gift Vehicle Pass.');
    expect(plain).toContain('SAP FAQs (https://docs.google.com/document/d/1wuucvq017bQHP7-0uH2KlSWSaYW7CSvNN7siU11Ah7k/edit)');
    expect(plain.match(/\[Image\]/g)).toHaveLength(3);
    expect(plain).not.toContain('{"root"');
  });

  it('leaves out the pending deletion in the fixture', () => {
    const state = JSON.parse(fixture);
    const markers: any[] = [];
    const walk = (node: any) => {
      if (node.type === 'deleted-text') markers.push(node);
      (node.children || []).forEach(walk);
    };
    walk(state.root);
    expect(markers).toHaveLength(1);
    const { html } = renderContentForEmail(fixture, { publicUrl: 'https://dev.scrivenly.com/api' });
    expect(html).not.toContain('tracked-deletion');
    expect(html).toContain('the payment process</u>.\\</li>'); // the text before the marker stays, the marker doesn't
  });
});
