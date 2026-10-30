/* @ds-bundle: {"format":4,"namespace":"TheDedhamGroupDesignSystem_fb91ae","components":[{"name":"SlideFooter","sourcePath":"components/slides/SlideFooter.jsx"},{"name":"SlideLayout","sourcePath":"components/slides/SlideLayout.jsx"},{"name":"SlideTitle","sourcePath":"components/slides/SlideTitle.jsx"}],"sourceHashes":{"components/slides/SlideFooter.jsx":"19b918101b57","components/slides/SlideLayout.jsx":"5e292751d887","components/slides/SlideTitle.jsx":"d8f8f401eecc"},"inlinedExternals":[],"unexposedExports":[]} */

(() => {

const __ds_ns = (window.TheDedhamGroupDesignSystem_fb91ae = window.TheDedhamGroupDesignSystem_fb91ae || {});

const __ds_scope = {};

(__ds_ns.__errors = __ds_ns.__errors || []);

// components/slides/SlideFooter.jsx
try { (() => {
/**
 * TDG slide footer: 2px blue rule, logo left, confidentiality center, page number right.
 * Absolutely-positioned at the bottom of SlideLayout.
 */
function SlideFooter({
  logoSrc = '',
  pageNumber = '',
  confidentiality = 'CONFIDENTIAL AND PROPRIETARY',
  dark = false
}) {
  const textColor = dark ? 'rgba(255,255,255,0.5)' : '#526B7A';
  const bg = dark ? '#1C2C59' : '#FFFFFF';
  return /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      bottom: 0,
      left: 0,
      right: 0,
      height: '36px',
      borderTop: '2px solid #27698D',
      display: 'flex',
      alignItems: 'center',
      padding: '0 48px',
      justifyContent: 'space-between',
      backgroundColor: bg,
      boxSizing: 'border-box'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: '130px'
    }
  }, logoSrc ? /*#__PURE__*/React.createElement("img", {
    src: logoSrc,
    alt: "The Dedham Group",
    style: {
      height: '20px'
    }
  }) : /*#__PURE__*/React.createElement("span", {
    style: {
      color: '#1C2C59',
      fontSize: '9pt',
      fontWeight: 500,
      fontFamily: '"Jost",sans-serif'
    }
  }, "The Dedham Group")), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: '7.5pt',
      color: textColor,
      fontFamily: '"Jost",sans-serif',
      letterSpacing: '0.06em',
      textTransform: 'uppercase'
    }
  }, confidentiality), /*#__PURE__*/React.createElement("div", {
    style: {
      width: '130px',
      textAlign: 'right'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: '9pt',
      color: textColor,
      fontFamily: '"Jost",sans-serif'
    }
  }, pageNumber)));
}
Object.assign(__ds_scope, { SlideFooter });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/slides/SlideFooter.jsx", error: String((e && e.message) || e) }); }

// components/slides/SlideLayout.jsx
try { (() => {
/**
 * 16:9 slide canvas wrapper (1280×720px). Place all slide content inside.
 * Handles background color and overflow clipping.
 */
function SlideLayout({
  children,
  dark = false,
  style
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      width: '1280px',
      height: '720px',
      backgroundColor: dark ? '#1C2C59' : '#FFFFFF',
      fontFamily: '"Jost","Tw Cen MT","Century Gothic",sans-serif',
      position: 'relative',
      overflow: 'hidden',
      boxSizing: 'border-box',
      ...style
    }
  }, children);
}
Object.assign(__ds_scope, { SlideLayout });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/slides/SlideLayout.jsx", error: String((e && e.message) || e) }); }

// components/slides/SlideTitle.jsx
try { (() => {
/**
 * TDG slide headline with 2px blue underline rule.
 * Used at the top of all body-layout slides.
 */
function SlideTitle({
  children,
  accent = '#27698D',
  color = '#1C2C59',
  size = '24pt',
  weight = 500
}) {
  return /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("h1", {
    style: {
      fontSize: size,
      fontWeight: weight,
      color: color,
      fontFamily: '"Jost","Tw Cen MT","Century Gothic",sans-serif',
      margin: 0,
      lineHeight: 1.2,
      paddingBottom: '10px',
      borderBottom: `2px solid ${accent}`
    }
  }, children));
}
Object.assign(__ds_scope, { SlideTitle });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/slides/SlideTitle.jsx", error: String((e && e.message) || e) }); }

__ds_ns.SlideFooter = __ds_scope.SlideFooter;

__ds_ns.SlideLayout = __ds_scope.SlideLayout;

__ds_ns.SlideTitle = __ds_scope.SlideTitle;

})();
