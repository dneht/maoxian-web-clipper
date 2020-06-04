"use strict";

import stripCssComments from 'strip-css-comments';
import Log              from '../lib/log.js';
import T                from '../lib/tool.js';
import Asset            from '../lib/asset.js';
import Task             from '../lib/task.js';
import ExtMsg           from '../lib/ext-msg.js';
import CaptureTool      from './tool.js';

/**
 * Capture CSS link
 *
 * @param {Object} opts
 *   - {String} link
 *   - {String} baseUrl
 *   - {String} docUrl
 *   - {Object} storageInfo
 *   - {String} clipId
 *   - {Object} mimeTypeDict
 *   - {Object} config
 *   - {Object} headerParams
 *   - {Array}  processedUrls
 *   - {Boolean} needFixStyle
 *
 * @return {Object}
 *   - {String} cssText
 *   - {Array}  tasks
 *
 */
async function captureLink(params) {
  const {baseUrl, docUrl, storageInfo, clipId, mimeTypeDict={}, config, headerParams, processedUrls=[], needFixStyle} = params;

  const {isValid, url, message} = T.completeUrl(params.link, baseUrl);
  if (!isValid) {
    console.warn("<mx-wc>", message);
    return {cssText: '', tasks: []}
  }

  try {
    const {fromCache, result: text} = await ExtMsg.sendToBackend( 'clipping', {
      type: 'fetch.text',
      body: {
        clipId: clipId,
        url: url,
        headers: CaptureTool.getRequestHeaders(url, headerParams),
        timeout: config.requestTimeout,
        tries: config.requestMaxTries,
      }
    });

    const _captureStyle = async function() {
      processedUrls.push(url);
      // Use url as baseUrl
      return await captureText(Object.assign({
        baseUrl: url,
        docUrl: docUrl,
        cssUrl: (config.embedCss ? docUrl : url),
      }, {
        text, storageInfo, clipId, mimeTypeDict, config, headerParams, needFixStyle
      }, {
        processedUrls: [...processedUrls]
      }));
    }

    if (fromCache) {
      if (config.embedCss) {
        // although we captured same style before. We still capture it,
        // otherwise it'll become too complicated ...
        const {cssText, tasks} = await _captureStyle();
        return {cssText: cssText, tasks: []}
      } else {
        // processed.
        return {cssText: '', tasks: []}
      }
    } else {

      const {cssText, tasks} = await _captureStyle();
      if (config.embedCss) {
        return {cssText: cssText, tasks: tasks};
      } else {
        const assetName = Asset.getNameByLink({
          link: url,
          extension: 'css',
          prefix: clipId
        });
        const filename = Asset.getFilename({storageInfo, assetName});

        tasks.push(Task.createStyleTask(filename, cssText, clipId));
        return {cssText: '', tasks: tasks};
      }
    }
  } catch(err) {
    // Fetching text is rejected
    Log.error(`fetch.text request css (url:${url}) failed`, err.message);
    // it's fine.
    return {cssText: '', tasks: []};
  }
}

/**
 * Capture CSS text
 *
 * @param {Object} opts
 *   - {String} text
 *   - {String} baseUrl
 *              This is the baseUrl of asset url(they may be relative).
 *              If text come from <style> tag or style attribute, then baseUrl is the web page's baseUrl
 *              If text come from <link rel="stylesheet">, then baseUrl is the href attribute of <link> tag
 *   - {String} docUrl
 *              url of document
 *   - {String} cssUrl
 *              Where the captured text will be placed. it'll be used to determine asset paths.
 *              If the captured text will be embed in html file. then the cssUrl is the web page's url
 *              else the cssUrl is the external style's url
 *   - {Object} storageInfo
 *   - {String} clipId
 *   - {Object} mimeTypeDict
 *   - {Object} config
 *   - {Object} headerParams
 *   - {Array}  processedUrls
 *   - {Boolean} needFixStyle
 *
 * @return {Object}
 *   - {String} cssText
 *   - {Array}  tasks
 */


async function captureText(params) {
  const {baseUrl, docUrl, storageInfo, clipId, mimeTypeDict={}, config, headerParams, processedUrls=[], needFixStyle} = params;
  const cssUrl = (params.cssUrl || baseUrl);
  let {text: styleText} = params;
  const taskCollection = [];

  // FIXME danger here (order matter)
  const ruleA = {
    regExp: /url\("[^\)]+"\)/igm,
    separator: '"',
    baseUrl: baseUrl,
    getReplacement: getReplacement_common,
  };

  const ruleB = {
    regExp: /url\('[^\)]+'\)/igm,
    separator: "'",
    baseUrl: baseUrl,
    getReplacement: getReplacement_common,
  };

  const ruleC = {
    regExp: /url\([^\)'"]+\)/igm,
    separator: /\(|\)/,
    baseUrl: baseUrl,
    getReplacement: getReplacement_common,
  };

  // rules for import styles
  const rulexA = {
    regExp: /@import\s+url\("[^\)]+"\)\s*([^;]*);$/igm,
    separator: '"',
    baseUrl: baseUrl,
    embedCss: config.embedCss,
    getReplacement: getReplacement_style,
  };
  const rulexB = {
    regExp: /@import\s+url\('[^\)]+'\)\s*([^;]*);$/igm,
    separator: "'",
    baseUrl: baseUrl,
    embedCss: config.embedCss,
    getReplacement: getReplacement_style,
  };
  const rulexC = {
    regExp: /@import\s+url\([^\)'"]+\)\s*([^;]*);$/igm,
    separator: /\(|\)/,
    baseUrl: baseUrl,
    embedCss: config.embedCss,
    getReplacement: getReplacement_style,
  };

  const rulexD = {
    regExp: /@import\s*'[^;']+'\s*([^;]*);$/igm,
    separator: "'",
    baseUrl: baseUrl,
    embedCss: config.embedCss,
    getReplacement: getReplacement_style,
  };
  const rulexE = {
    regExp: /@import\s*"[^;"]+"\s*([^;]*);$/igm,
    separator: '"',
    baseUrl: baseUrl,
    embedCss: config.embedCss,
    getReplacement: getReplacement_style,
  };

  styleText = stripCssComments(styleText);

  const commonParams = { baseUrl, docUrl, cssUrl, clipId, storageInfo, mimeTypeDict };

  let parsedResult, result;

  // fonts
  const fontRegExp = /@font-face\s?\{[^\}]+\}/gm;
  parsedResult = parseAsset({
    styleText: styleText,
    regExp: fontRegExp,
    rules: [ruleA, ruleB, ruleC],
    saveAsset: config.saveWebFont,
  });
  result = generateTasks(Object.assign({
    taskType: 'fontFileTask',
  }, commonParams, parsedResult));
  styleText = result.styleText;
  taskCollection.push(...result.tasks);

  // background
  const bgRegExp = /background:([^:;]*url\([^\)]+\)[^:;]*)+;/img;
  parsedResult = parseAsset({
    styleText: styleText,
    regExp: bgRegExp,
    rules: [ruleA, ruleB, ruleC],
    saveAsset: config.saveCssImage,
  });
  result = generateTasks(Object.assign({
    taskType: 'imageFileTask',
  }, commonParams, parsedResult));
  styleText = result.styleText;
  taskCollection.push(...result.tasks);


  // background-image
  const bgImgRegExp = /background-image:([^:;]*url\([^\)]+\)[^:;]*)+;/img;
  parsedResult = parseAsset({
    styleText: styleText,
    regExp: bgImgRegExp,
    rules: [ruleA, ruleB, ruleC],
    saveAsset: config.saveCssImage,
  });
  result = generateTasks(Object.assign({
    taskType: 'imageFileTask',
  }, commonParams, parsedResult));
  styleText = result.styleText;
  taskCollection.push(...result.tasks);

  // border-image
  const borderImgExp = /border-image:([^:;]*url\([^\)]+\)[^:;]*)+;/img;
  parsedResult = parseAsset({
    styleText: styleText,
    regExp: borderImgExp,
    rules: [ruleA, ruleB, ruleC],
    saveAsset: config.saveCssImage,
  });
  result = generateTasks(Object.assign({
    taskType: 'imageFileTask',
  }, commonParams, parsedResult));
  styleText = result.styleText;
  taskCollection.push(...result.tasks);

  // @import css
  const cssRegExp = /@import[^;]+;/igm;
  parsedResult = parseAsset({
    styleText: styleText,
    regExp: cssRegExp,
    rules: [rulexA, rulexB, rulexC, rulexD, rulexE],
    saveAsset: true
  });

  if (config.embedCss) {
    const urls = parsedResult.marker.values;
    const importedStyles = [];
    for (let i = 0; i < urls.length; i++) {
      if (processedUrls.indexOf(urls[i]) > -1) {
        // circle dependency, avoid it
        importedStyles.push('');
      } else {
        const r = await captureLink(Object.assign({
          link: urls[i],
          config: config,
          headerParams: headerParams,
          processedUrls: [...processedUrls],
          needFixStyle: needFixStyle,
        }, commonParams));
        importedStyles.push(r.cssText);
        taskCollection.push(...r.tasks);
      }
    }
    styleText = embedImportedStyle({
      styleText: parsedResult.styleText,
      marker: parsedResult.marker,
      importedStyles: importedStyles,
    })
  } else {
    result = generateTasks(Object.assign({
      taskType: 'styleFileTask',
      extension: 'css'
    }, commonParams, parsedResult));

    styleText = result.styleText;
    // convert css url task to text task.
    for(let i = 0; i < result.tasks.length; i++) {
      const r = await captureLink(Object.assign({
        link: result.tasks[i].url,
        config: config,
        headerParams: headerParams,
        needFixStyle: needFixStyle,
      }, commonParams));
      taskCollection.push(...r.tasks);
    }
  }


  if (needFixStyle) {
    styleText = fixBodyChildrenStyle(styleText);
  }

  return {cssText: styleText, tasks: taskCollection};
}


/**
 * Parse style text according to regular expression of asset
 *
 * @param {Object} params:
 *   - {String}  styleText
 *   - {RegExp}  regExp
 *   - {Array}   rules
 *   - {Boolean} saveAsset
 *
 * @return {Object}
 *   - {String} styleText
 *   - {Marker} marker
 */
function parseAsset(params) {
  const  {regExp, rules, saveAsset} = params;

  let {styleText} = params;
  let marker = T.createMarker();

  styleText = styleText.replace(regExp, (match) => {
    const r = parseTextUrl({
      cssText: match,
      rules: rules,
      marker: marker,
      saveAsset: saveAsset,
    });
    marker = r.marker;
    return r.cssText;
  });

  return {styleText: styleText, marker: marker};
}

/**
 * Parse style text according to rules, mark all target urls and collect them.
 *
 * @param {Object} params
 *   - {String}   cssText
 *   - {Array}    rules
 *   - {Marker}   marker
 *   - {Boolean}  svaeAsset
 *
 * @return {Object}
 *   - {String} cssText
 *   - {Marker} marker
 */
function parseTextUrl(params) {

  const {rules, marker, saveAsset} = params;
  let cssText = params.cssText;

  T.each(rules, function(rule){
    const replacement = rule.getReplacement(marker, saveAsset);
    cssText = cssText.replace(rule.regExp, replacement);
  });
  return { cssText: cssText, marker: marker};
}


/**
 * create a replacement function. It'll be Used on web fonts, css images.
 *
 * @param {Marker} marker
 *                 Used to collect url and replace it with a marker.
 * @param {Boolean} saveAsset
 *                  Whether to save asset or not.
 * @return {Function}
 */
function getReplacement_common(marker, saveAsset) {
  const {separator, baseUrl} = this;

  return function(match) {
    const path = match.split(separator)[1].trim();
    const {isValid, url, message} = T.completeUrl(path, baseUrl);
    if (!isValid) {
      const err = [message, `path: ${path}`].join(' ');
      //TODO add error message
      return 'url("")';
    }
    if(T.isDataUrl(url) || T.isHttpUrl(url)) {
      if(saveAsset){
        marker.values.push(url);
        return `url("${marker.next()}")`;
      } else {
        // set variable to blank
        return 'url("")';
      }
    } else {
      return match;
    }
  }
}

/**
 * create a replacement function. It'll be used on style import (@import url();)
 *
 * @param {Marker} marker
 *                 Used to collect url and replace it with a marker.
 * @param {Boolean} saveAsset
 *                  Whether to save asset or not. In this function it's always true.
 * @return {Function}
 */
function getReplacement_style(marker, saveAsset) {
  const {separator, baseUrl, embedCss} = this;

  return function(match, p1) {
    const path = match.split(separator)[1].trim();
    const {isValid, url, message} = T.completeUrl(path, baseUrl);
    if (!isValid) {
      const err = [message, `path: ${path}`].join(' ');
      return `/*error: ${err}*/`;
    }
    if(T.isDataUrl(url) || T.isHttpUrl(url)) {
      marker.values.push(url);
      if (embedCss) {
        if (p1.trim() === "") {
          return marker.next();
        } else {
          return `@media ${p1.trim()} {\n${marker.next()}\n}\n`;
        }
      } else {
        if (p1.trim() === "") {
          return `@import url("${marker.next()}");`;
        } else {
          return `@import url("${marker.next()}") ${p1.trim()};`;
        }
      }
    } else {
      return match;
    }
  }
}

/**
 * Generate Task according to asset url, and replace marker back to asset path.
 *
 * @param {Object} params
 *   - {String} styleText
 *   - {Marker} marker
 *   - {String} baseUrl
 *   - {String} docUrl
 *   - {String} clipId
 *   - {Object} storageInfo
 *   - {Object} mimeTypeDict
 *   - {String} extension
 *   - {String} taskType
 *
 * @return {Object{
 *   - {String} styleText
 *   - {Array} tasks
 */
function generateTasks(params) {
  const {cssUrl, docUrl, clipId, storageInfo,
    mimeTypeDict, extension, taskType} = params;
  let styleText = params.styleText;
  const tasks = []

  styleText = params.marker.replaceBack(styleText, (url, index) => {
    const assetName = Asset.getNameByLink({
      link: url,
      extension: extension,
      prefix: clipId,
      mimeTypeData: {httpMimeType: mimeTypeDict[url]}
    });
    const filename = Asset.getFilename({storageInfo, assetName});
    tasks.push(Task.createUrlTask(filename, url, clipId, taskType));
    if(cssUrl === docUrl){
      return Asset.getPath({storageInfo, assetName});
    }else{
      return assetName;
    }
  });
  return {styleText: styleText, tasks}
}


/**
 * Embed imported styles into marked style text.
 *
 * @param {params}
 *   - {String} styleText
 *   - {Marker} marker
 *   - {Array}  importedStyles
 *
 * @return {String} styleText
 */
function embedImportedStyle(params) {
  const {marker, importedStyles} = params;
  let styleText = params.styleText;
  return marker.replaceBack(styleText, (url, index) => {
    return importedStyles[index];
  });
}

/**
 * We wrap captured html in a div (with class mx-wc-main),
 * So we should fix this.
 */
function fixBodyChildrenStyle(css) {
  const cssBodyExp = /(^|[\{\}\s,;]{1})(body\s*>\s?)/igm;
  return css.replace(cssBodyExp, function(match, p1, p2){
    return match.replace(p2, "body > .mx-wc-main > ");
  });
}


const CapturerCss = {
  captureText: captureText,
  captureLink: captureLink
}

export default CapturerCss;
