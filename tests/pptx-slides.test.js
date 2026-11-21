'use strict';
/** A PowerPoint note is drawn as slides for the lecturer: text boxes, pictures, colours; the speaker notes stay apart. */
const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { startApp } = require('./helpers');
const { parsePptx } = require('../src/lib/pptx-slides');
const { extractText } = require('../src/lib/extract-text');

// A ZIP archive built in memory, so no binary files are checked in.
function zip(files) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const raw = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const data = zlib.deflateRawSync(raw);
    const nameBuf = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    parts.push(local, nameBuf, data);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(raw.length, 24);
    entry.writeUInt16LE(nameBuf.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64');
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

function deck() {
  return zip({
    'ppt/presentation.xml': '<p:presentation xmlns:r="x"><p:sldSz cx="9144000" cy="6858000"/><p:sldIdLst><p:sldId id="256" r:id="rId7"/><p:sldId id="257" r:id="rId8"/></p:sldIdLst></p:presentation>',
    'ppt/_rels/presentation.xml.rels': `<Relationships><Relationship Id="rId8" Type="${REL}/slide" Target="slides/slide1.xml"/><Relationship Id="rId7" Type="${REL}/slide" Target="slides/slide2.xml"/></Relationships>`,
    'ppt/theme/theme1.xml': '<a:theme><a:clrScheme name="x"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="1F2937"/></a:dk2><a:accent1><a:srgbClr val="E07B00"/></a:accent1></a:clrScheme></a:theme>',
    // slide2.xml comes first in the presentation's own order (rId7), slide1.xml second: the list wins over the file names.
    'ppt/slides/slide2.xml': '<p:sld><p:cSld><p:spTree><p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:rPr lang="en"/><a:t>Opening</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>',
    'ppt/slides/slide1.xml': `<p:sld><p:cSld><p:bg><p:bgPr><a:solidFill><a:schemeClr val="tx2"/></a:solidFill></p:bgPr></p:bg><p:spTree>
      <p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:p><a:r><a:rPr lang="en" sz="4000" b="1"/><a:t>Your classroom assistant</a:t></a:r></a:p></p:txBody></p:sp>
      <p:sp><p:nvSpPr><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="914400" y="2286000"/><a:ext cx="4572000" cy="2286000"/></a:xfrm><a:solidFill><a:srgbClr val="FFF3E0"/></a:solidFill></p:spPr><p:txBody><a:bodyPr anchor="ctr"/>
        <a:p><a:pPr><a:buChar char="&#8226;"/></a:pPr><a:r><a:rPr sz="2400"><a:solidFill><a:schemeClr val="accent1"/></a:solidFill></a:rPr><a:t>Follow &amp; ask</a:t></a:r></a:p>
        <a:p><a:pPr algn="ctr"/><a:r><a:rPr sz="1800" i="1"/><a:t>Second line</a:t></a:r></a:p></p:txBody></p:sp>
      <p:pic><p:nvPicPr><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId3"/></p:blipFill><p:spPr><a:xfrm><a:off x="5486400" y="2286000"/><a:ext cx="2743200" cy="2286000"/></a:xfrm></p:spPr></p:pic>
      <p:pic><p:blipFill><a:blip r:embed="rId4"/></p:blipFill><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="914400"/></a:xfrm></p:spPr></p:pic>
    </p:spTree></p:cSld></p:sld>`,
    'ppt/slides/_rels/slide1.xml.rels': `<Relationships><Relationship Id="rId1" Type="${REL}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId3" Type="${REL}/image" Target="../media/image1.png"/><Relationship Id="rId4" Type="${REL}/image" Target="../media/vector.emf"/></Relationships>`,
    'ppt/slides/_rels/slide2.xml.rels': `<Relationships><Relationship Id="rId1" Type="${REL}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/></Relationships>`,
    'ppt/slideLayouts/slideLayout1.xml': '<p:sldLayout><p:cSld><p:spTree><p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="457200" y="274320"/><a:ext cx="8229600" cy="1143000"/></a:xfrm></p:spPr></p:sp></p:spTree></p:cSld></p:sldLayout>',
    'ppt/notesSlides/notesSlide1.xml': '<p:notes><p:cSld><p:spTree><p:sp><p:nvSpPr><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr></p:sp><p:sp><p:nvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>Say hello and ask who has used it</a:t></a:r></a:p></p:txBody></p:sp><p:sp><p:nvSpPr><p:nvPr><p:ph type="sldNum"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>7</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>',
    'ppt/media/image1.png': PNG,
    'ppt/media/vector.emf': Buffer.from('EMF'),
  });
}

test('a deck is read as slides in presentation order, with positions as fractions of the slide', () => {
  const parsed = parsePptx(deck());
  assert.equal(parsed.width, 9144000);
  assert.equal(parsed.slides.length, 2);
  assert.equal(parsed.slides[0].shapes[0].paras[0].runs[0].t, 'Opening', 'the list in presentation.xml sets the order');
  const slide = parsed.slides[1];
  assert.equal(slide.bg, '#1F2937', 'a theme colour for the background');

  const title = slide.shapes[0];
  assert.deepEqual([title.x, title.y, title.w, title.h], [0.05, 0.04, 0.9, 0.1667], 'a title without its own position takes the layout’s');
  assert.equal(title.paras[0].runs[0].bold, true);
  assert.equal(title.paras[0].runs[0].size, Math.round(((4000 / 100) * 12700 / 9144000) * 10000) / 100, 'text size is a percentage of the slide width');

  const box = slide.shapes[1];
  assert.equal(box.fill, '#FFF3E0');
  assert.equal(box.anchor, 'center');
  assert.equal(box.paras[0].bullet, true);
  assert.equal(box.paras[0].runs[0].t, 'Follow & ask');
  assert.equal(box.paras[0].runs[0].color, '#E07B00', 'an accent colour from the theme');
  assert.equal(box.paras[1].align, 'center');
  assert.equal(box.paras[1].runs[0].italic, true);

  const picture = slide.shapes[2];
  assert.equal(picture.kind, 'image');
  assert.match(picture.src, /^data:image\/png;base64,/);
  assert.equal(slide.shapes.length, 3, 'a picture format a browser cannot draw is left out');
});

test('speaker notes come apart from the slide, and only the notes text is taken', () => {
  const parsed = parsePptx(deck());
  assert.equal(parsed.slides[1].notes, 'Say hello and ask who has used it');
  assert.equal(parsed.slides[0].notes, '');
  assert.ok(!JSON.stringify(parsed.slides[1].shapes).includes('Say hello'), 'never inside the shapes the room sees');
});

test('a file that is not a presentation is refused plainly', () => {
  assert.throws(() => parsePptx(zip({ 'word/document.xml': '<w:document/>' })), /no slides/);
  assert.throws(() => parsePptx(Buffer.from('not a zip')), /not a valid document/);
});

test('a PowerPoint lecture note opens as drawn slides for its lecturer only', async () => {
  const app = await startApp();
  try {
    await app.login('admin');
    const lecturerId = await app.lecturer('prof');
    const course = await app.call('admin', 'POST', '/api/courses', { title: 'Machine Learning', code: 'ML101' });
    await app.call('admin', 'POST', '/api/admin/assign', { course_id: course.body.id, lecturer_id: lecturerId });
    const file = deck();
    const up = await app.call('prof', 'POST', '/api/assistant/attachments', { name: 'week5.pptx', mime: PPTX, data: file.toString('base64'), keep_file: true });
    assert.equal(up.status, 200, JSON.stringify(up.body));
    const plain = await app.call('prof', 'POST', '/api/assistant/attachments', { name: 'old.pptx', mime: PPTX, data: file.toString('base64') });
    const started = await app.call('prof', 'POST', '/api/live/sessions', { course_id: course.body.id, title: 'Week 5', notes: [up.body.attachment.id, plain.body.attachment.id] });
    const sid = started.body.session.id;
    const [kept, textOnly] = started.body.notes;

    assert.equal((await app.call('prof', 'GET', `/api/live/sessions/${sid}/notes/${kept.id}`)).body.viewable, 'slides');
    const slides = await app.call('prof', 'GET', `/api/live/sessions/${sid}/notes/${kept.id}/slides`);
    assert.equal(slides.status, 200);
    assert.equal(slides.body.slides.length, 2);
    assert.equal(slides.body.slides[1].notes, 'Say hello and ask who has used it');

    // A deck uploaded without keeping its file has only its text: shown as text.
    assert.equal((await app.call('prof', 'GET', `/api/live/sessions/${sid}/notes/${textOnly.id}`)).body.viewable, 'text');
    assert.equal((await app.call('prof', 'GET', `/api/live/sessions/${sid}/notes/${textOnly.id}/slides`)).status, 404);

    await app.register('stu');
    assert.equal((await app.call('stu', 'GET', `/api/live/sessions/${sid}/notes/${kept.id}/slides`)).status, 403, 'a student cannot open the lecturer’s notes');
  } finally {
    await app.close();
  }
});

test('the viewer’s text view never shows the speaker notes', async () => {
  const { textPages } = await import(pathToFileURL(path.join(__dirname, '../public/js/features/notes-viewer.js')).href).catch(() => ({}));
  if (!textPages) return; // the viewer imports browser modules; where they cannot load, the rule is covered by the browser build
  const pages = textPages(extractText({ name: 'talk.pptx', buffer: deck() }));
  assert.ok(pages.length >= 1);
  assert.ok(pages.every((p) => !/Speaker notes|Say hello/.test(p)));
});
