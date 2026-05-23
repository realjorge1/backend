/**
 * Reflow Service — Extracts text from PDF and DOCX files,
 * then builds responsive HTML suitable for mobile reading.
 */
const { parsePDF: pdfParse } = require("../utils/pdfParser");
const mammoth = require("mammoth");

// ============================================================================
// HTML BUILDER
// ============================================================================

const THEMES = {
  light: { bg: "#ffffff", text: "#1a1a1a", link: "#0066cc", border: "#e0e0e0" },
  sepia: { bg: "#f4ecd8", text: "#5c4a3a", link: "#8b4513", border: "#d4c4a8" },
  dark: { bg: "#1a1a1a", text: "#e0e0e0", link: "#66b3ff", border: "#333333" },
};

function escapeHtml(text) {
  const map = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  };
  return text.replace(/[&<>"']/g, (m) => map[m]);
}

function buildReflowHTML({ title, bodyContent, options, plainText }) {
  const {
    fontSize = 16,
    lineHeight = 1.6,
    theme = "light",
    fontFamily = "system-ui",
  } = options;
  const t = THEMES[theme] || THEMES.light;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=5.0, user-scalable=yes">
<title>${escapeHtml(title)}</title>
<style>
:root{--fs:${fontSize}px;--lh:${lineHeight};--ff:${fontFamily},-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;--bg:${t.bg};--fg:${t.text};--link:${t.link};--border:${t.border}}
*{margin:0;padding:0;box-sizing:border-box}
html{font-size:var(--fs);-webkit-text-size-adjust:100%}
body{font-family:var(--ff);line-height:var(--lh);color:var(--fg);background:var(--bg);padding:0;margin:0;overflow-x:hidden;-webkit-font-smoothing:antialiased}
.reader-content{max-width:100%;padding:20px 16px;margin:0 auto}
p{margin-bottom:1em;text-align:left;word-wrap:break-word;overflow-wrap:break-word}
h1,h2,h3,h4,h5,h6{margin-top:1.5em;margin-bottom:.5em;font-weight:600;line-height:1.3;color:var(--fg)}
h1{font-size:1.8em}h2{font-size:1.5em}h3{font-size:1.3em}h4{font-size:1.1em}
h1:first-child,h2:first-child,h3:first-child{margin-top:0}
a{color:var(--link);text-decoration:underline;word-break:break-word}
ul,ol{margin-bottom:1em;padding-left:1.5em}
li{margin-bottom:.5em}
strong,b{font-weight:600}em,i{font-style:italic}
code{font-family:'Courier New',Courier,monospace;background:rgba(0,0,0,.05);padding:2px 4px;border-radius:3px;font-size:.9em}
pre{background:rgba(0,0,0,.05);padding:12px;border-radius:4px;overflow-x:auto;margin-bottom:1em}
pre code{background:none;padding:0}
img{max-width:100%;height:auto;display:block;margin:1em auto;border-radius:4px}
table{width:100%;border-collapse:collapse;margin-bottom:1em;display:block;overflow-x:auto}
th,td{border:1px solid var(--border);padding:8px 12px;text-align:left}
th{background:rgba(0,0,0,.05);font-weight:600}
blockquote{border-left:4px solid var(--border);padding-left:1em;margin:1em 0;font-style:italic;opacity:.9}
hr{border:none;border-top:2px solid var(--border);margin:2em 0}
::selection{background:rgba(100,150,255,.3)}
.search-highlight{background:#FFEB3B;color:#000;border-radius:2px;padding:0 1px}
.search-highlight-active{background:#FF9800;color:#000}
.user-highlight{border-radius:2px;padding:0 1px}
</style>
</head>
<body class="theme-${theme}">
<article class="reader-content" id="reader-content">
${bodyContent}
</article>
<script>
(function(){
  // Scroll position reporting
  var scrollTimer;
  window.addEventListener('scroll',function(){
    clearTimeout(scrollTimer);
    scrollTimer=setTimeout(function(){
      var pct=(window.scrollY/(document.documentElement.scrollHeight-window.innerHeight))*100;
      window.ReactNativeWebView&&window.ReactNativeWebView.postMessage(JSON.stringify({type:'scroll',scrollY:window.scrollY,scrollPercent:Math.round(pct)}));
    },150);
  });

  // Style update from RN
  window.updateStyles=function(fs,lh,th){
    var r=document.documentElement;
    r.style.setProperty('--fs',fs+'px');
    r.style.setProperty('--lh',lh);
    var themes=${JSON.stringify(THEMES)};
    var t=themes[th]||themes.light;
    r.style.setProperty('--bg',t.bg);
    r.style.setProperty('--fg',t.text);
    r.style.setProperty('--link',t.link);
    r.style.setProperty('--border',t.border);
    document.body.className='theme-'+th;
  };

  window.scrollToPosition=function(pos){window.scrollTo({top:pos,behavior:'smooth'})};

  // Search support
  window.__searchHighlights=[];
  window.__searchCurrentIdx=-1;

  window.clearSearch=function(){
    window.__searchHighlights.forEach(function(el){
      var p=el.parentNode;if(!p)return;
      p.replaceChild(document.createTextNode(el.textContent),el);
      p.normalize();
    });
    window.__searchHighlights=[];
    window.__searchCurrentIdx=-1;
  };

  window.searchText=function(query){
    window.clearSearch();
    if(!query){window.ReactNativeWebView&&window.ReactNativeWebView.postMessage(JSON.stringify({type:'search-result',count:0,current:-1}));return;}
    var q=query.toLowerCase();
    var walker=document.createTreeWalker(document.getElementById('reader-content'),NodeFilter.SHOW_TEXT,null,false);
    var nodes=[];while(walker.nextNode())nodes.push(walker.currentNode);
    var count=0;
    nodes.forEach(function(node){
      var text=node.nodeValue;var lower=text.toLowerCase();var idx=lower.indexOf(q);
      if(idx===-1)return;
      var frag=document.createDocumentFragment();var last=0;
      while(idx!==-1){
        frag.appendChild(document.createTextNode(text.substring(last,idx)));
        var span=document.createElement('span');
        span.className='search-highlight';
        span.setAttribute('data-search-idx',count);
        span.textContent=text.substring(idx,idx+q.length);
        frag.appendChild(span);
        window.__searchHighlights.push(span);
        count++;last=idx+q.length;idx=lower.indexOf(q,last);
      }
      frag.appendChild(document.createTextNode(text.substring(last)));
      node.parentNode.replaceChild(frag,node);
    });
    if(window.__searchHighlights.length>0){
      window.__searchCurrentIdx=0;
      window.__searchHighlights[0].classList.add('search-highlight-active');
      window.__searchHighlights[0].scrollIntoView({behavior:'smooth',block:'center'});
    }
    window.ReactNativeWebView&&window.ReactNativeWebView.postMessage(JSON.stringify({type:'search-result',count:count,current:count>0?0:-1}));
  };

  window.searchNext=function(){
    if(window.__searchHighlights.length===0)return;
    if(window.__searchCurrentIdx>=0)window.__searchHighlights[window.__searchCurrentIdx].classList.remove('search-highlight-active');
    window.__searchCurrentIdx=(window.__searchCurrentIdx+1)%window.__searchHighlights.length;
    var el=window.__searchHighlights[window.__searchCurrentIdx];
    el.classList.add('search-highlight-active');
    el.scrollIntoView({behavior:'smooth',block:'center'});
    window.ReactNativeWebView&&window.ReactNativeWebView.postMessage(JSON.stringify({type:'search-result',count:window.__searchHighlights.length,current:window.__searchCurrentIdx}));
  };

  window.searchPrev=function(){
    if(window.__searchHighlights.length===0)return;
    if(window.__searchCurrentIdx>=0)window.__searchHighlights[window.__searchCurrentIdx].classList.remove('search-highlight-active');
    window.__searchCurrentIdx=(window.__searchCurrentIdx-1+window.__searchHighlights.length)%window.__searchHighlights.length;
    var el=window.__searchHighlights[window.__searchCurrentIdx];
    el.classList.add('search-highlight-active');
    el.scrollIntoView({behavior:'smooth',block:'center'});
    window.ReactNativeWebView&&window.ReactNativeWebView.postMessage(JSON.stringify({type:'search-result',count:window.__searchHighlights.length,current:window.__searchCurrentIdx}));
  };

  // Highlight support (user annotations)
  window.applyHighlights=function(highlights){
    // highlights = [{id,startOffset,endOffset,color}]
    // Applied on the flat text of reader-content
    // For simplicity, we use a class-based approach
    if(!highlights||highlights.length===0)return;
    highlights.forEach(function(h){
      try{
        var el=document.getElementById('reader-content');
        if(!el)return;
        var walker=document.createTreeWalker(el,NodeFilter.SHOW_TEXT,null,false);
        var offset=0;var node;
        while(node=walker.nextNode()){
          var len=node.nodeValue.length;
          if(offset+len>h.startOffset&&offset<h.endOffset){
            var start=Math.max(0,h.startOffset-offset);
            var end=Math.min(len,h.endOffset-offset);
            var range=document.createRange();
            range.setStart(node,start);
            range.setEnd(node,end);
            var span=document.createElement('span');
            span.className='user-highlight';
            span.style.backgroundColor=h.color||'rgba(255,235,59,0.4)';
            span.setAttribute('data-highlight-id',h.id);
            range.surroundContents(span);
          }
          offset+=len;
        }
      }catch(e){/* skip broken highlights */}
    });
  };

  // Text selection for highlighting
  document.addEventListener('selectionchange',function(){
    var sel=window.getSelection();
    if(!sel||sel.isCollapsed||!sel.toString().trim())return;
    var text=sel.toString();
    // Calculate offsets relative to reader-content
    try{
      var container=document.getElementById('reader-content');
      var range=sel.getRangeAt(0);
      var preRange=document.createRange();
      preRange.selectNodeContents(container);
      preRange.setEnd(range.startContainer,range.startOffset);
      var startOffset=preRange.toString().length;
      var endOffset=startOffset+text.length;
      window.ReactNativeWebView&&window.ReactNativeWebView.postMessage(JSON.stringify({
        type:'text-selected',
        text:text,
        startOffset:startOffset,
        endOffset:endOffset
      }));
    }catch(e){}
  });

  // Signal ready
  window.ReactNativeWebView&&window.ReactNativeWebView.postMessage(JSON.stringify({type:'ready'}));
})();
</script>
</body>
</html>`;
}

// ============================================================================
// PDF EXTRACTION
// ============================================================================

/**
 * Detect if a block of text is a heading based on heuristics.
 */
function detectBlockType(text) {
  const trimmed = text.trim();
  if (!trimmed) return "p";
  const isShort = trimmed.length < 120;
  const isCapitalized = trimmed === trimmed.toUpperCase() && trimmed.length > 2;
  const hasNoEndPunct = !/[.!?,;:]$/.test(trimmed);

  if (isShort && isCapitalized && hasNoEndPunct) return "h2";
  if (isShort && hasNoEndPunct && /^(chapter|section|part)\s/i.test(trimmed))
    return "h1";
  if (isShort && hasNoEndPunct && trimmed.length < 60) return "h3";
  return "p";
}

/**
 * Parse basic extracted text into paragraph blocks.
 */
function parseTextToBlocks(text) {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((p) => {
      const clean = p.replace(/\n/g, " ").replace(/\s+/g, " ");
      return { type: detectBlockType(clean), content: clean };
    });
}

/**
 * Build HTML from structured blocks.
 */
function blocksToHTML(blocks) {
  return blocks
    .map((b) => {
      const content = escapeHtml(b.content);
      switch (b.type) {
        case "h1":
          return `<h1>${content}</h1>`;
        case "h2":
          return `<h2>${content}</h2>`;
        case "h3":
          return `<h3>${content}</h3>`;
        default:
          return `<p>${content}</p>`;
      }
    })
    .join("\n");
}

/**
 * Extract structured text from a PDF buffer and return reflow HTML.
 */
async function reflowPDF(buffer, originalName, options) {
  const data = await pdfParse(buffer);

  const hasText = data.text && data.text.trim().length > 50;
  if (!hasText) {
    return {
      success: false,
      isScanned: true,
      error: "No extractable text found",
      message:
        "This PDF appears to be scanned or image-based. Please use Original view.",
    };
  }

  const blocks = parseTextToBlocks(data.text);
  const bodyContent = blocksToHTML(blocks);
  const plainText = data.text;
  const wordCount = plainText.trim().split(/\s+/).length;

  const html = buildReflowHTML({
    title: originalName || "Document",
    bodyContent,
    options,
    plainText,
  });

  return {
    success: true,
    html,
    plainText,
    metadata: {
      pageCount: data.numpages || 0,
      wordCount,
      hasImages: false,
      extractionQuality: "medium",
    },
  };
}

// ============================================================================
// DOCX EXTRACTION
// ============================================================================

/**
 * Extract HTML from a DOCX buffer and return reflow HTML.
 */
async function reflowDOCX(buffer, originalName, options) {
  const result = await mammoth.convertToHtml(
    { buffer },
    {
      styleMap: [
        "p[style-name='Heading 1'] => h1:fresh",
        "p[style-name='Heading 2'] => h2:fresh",
        "p[style-name='Heading 3'] => h3:fresh",
        "p[style-name='Title'] => h1.title:fresh",
        "b => strong",
        "i => em",
      ],
      includeDefaultStyleMap: true,
    },
  );

  const rawHtml = result.value;
  // Simple word count from stripped text
  const textOnly = rawHtml
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const wordCount = textOnly.split(/\s+/).length;

  const html = buildReflowHTML({
    title: originalName || "Document",
    bodyContent: rawHtml,
    options,
    plainText: textOnly,
  });

  return {
    success: true,
    html,
    plainText: textOnly,
    metadata: {
      wordCount,
      hasImages: rawHtml.includes("<img"),
    },
  };
}

// ============================================================================
// TEXT EXTRACTION (for search index without full HTML rebuild)
// ============================================================================
async function extractPDFText(buffer) {
  const data = await pdfParse(buffer);
  return {
    text: data.text || "",
    pageCount: data.numpages || 0,
    hasText: !!(data.text && data.text.trim().length > 50),
  };
}

module.exports = {
  reflowPDF,
  reflowDOCX,
  extractPDFText,
};
