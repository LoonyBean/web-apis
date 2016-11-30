/**
 * @license
 * Copyright 2016 Google Inc. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
'use strict';

const gs = require('glob-stream');
const path = require('path');

const Base = require('../Base.es6.js');
const Memo = require('../memo/Memo.es6.js');
const memos = require('./memos.es6.js');

class BlinkLinkedRunner extends Base {
  init(opts) {
    super.init(opts);
    this.running = false;
    this.eachFilePromises = [];

    //
    // Setup custom memos tailored to this runner.
    //

    // Input: {blink-file-name, pipeline-runAll-output}.
    // Output: {spec-URLS-to-files mapping, spec-URLs-to-parses mapping}.
    this.gather = new Memo({
      getKey: () => {
        return Memo.hashCode(Object.keys(
          this.urlsToFiles
        ).sort().join('|')).toString();
      },
      f: ({file, output}) => {
        let urlsToFiles = this.urlsToFiles;
        let urlsToParses = this.urlsToParses;

        // Handle no URLs or parses found.
        // TODO: We should only have to check for one of these two
        // falsey/length=0 cases. Figure out which it should be.
        if (!output || (Array.isArray(output) && output.length === 0))
          return {urlsToFiles, urlsToParses};

        const urls = output.output;
        let parses = output.delegates;
        while (parses.length !== urls.length) {
          if (parses.length !== 1) throw new Error('Malformed memo output');
          parses = parses[0];
        }
        parses = parses.map(
          (parsesFromURL, i) => parsesFromURL.reduce(
            (acc, parseFromTag) => acc = acc.concat(parseFromTag),
            []
          )
        );

        for (let i = 0; i < urls.length; i++) {
          const url = urls[i];
          urlsToFiles[url] = urlsToFiles[url] || [];
          urlsToFiles[url].push(file);
          urlsToParses[urls[i]] = parses[i];
        }

        return {urlsToFiles, urlsToParses};
      },
    });

    // Input: {spec-URLS-to-files mapping, spec-URLs-to-parses mapping}.
    // Output: data/idl/blink/linked JSON blob:
    //         [{parses, url, files}].
    this.store = new Memo({
      getKey: () => 'blink-linked',
      cache: memos.ppcache('webidl-data'),
      f: ({urlsToFiles, urlsToParses}) => {
        let data = [];
        const urls = Object.keys(urlsToFiles);
        for (const url of urls) {
          data.push({
            url,
            files: urlsToFiles[url],
            parses: urlsToParses[url],
          });
        }
        return data;
      }
    });
  }

  configure(argv) {
    memos.configure(argv);
    this.blinkPath = path.resolve(argv.b);
  }

  run() {
    // TODO: Do something more robust?
    if (this.running) throw new Error('BlinkLinkedRunner already running');
    this.running = true;

    // Clear runner-output-data.
    this.urlsToFiles = {};
    this.urlsToParses = {};

    // Compose fresh set of memos for main pipeline computation(s).
    let first;
    this.unbind = memos.bind(
      first = memos.scrapeURLsFromFile(),
      memos.filterSpecURLs(),
      memos.scrapeHTMLForWebIDL(),
      memos.parseWebIDL()
    );
    this.pipeline = first.head;
    const finish = () => {
      this.unbind();
      this.running = false;
      return this;
    };

    // Find files for pipeline inputs
    this.globStream = gs.createStream(`${this.blinkPath}/**/*.idl`, [], {});
    this.globStream.on(
      'data',
      file => this.processFile(file.path.substr(`${this.blinkPath}/`.length))
    );

    // Return Promise handled by streaming input event listeners.
    return new Promise((resolve, reject) => {
      this.globStream.on('error', error => {
        return Promise.resolve(this.onError(resolve, reject, error)).then(
          finish, finish
        );
      });
      this.globStream.on('end', data => {
        return Promise.all(this.eachFilePromises).then(
          this.onDataReady.bind(this, resolve, reject, data),
          this.onError.bind(this, resolve, reject)
        );
      });
    });
  }

  // Invoke pipeline over each individual file, then add results to
  // runner-output-data variables.
  processFile(file) {
    const promise = this.pipeline.runAll(`${this.blinkPath}/${file}`).then(
      output => this.gather.run({file, output})
    );
    this.eachFilePromises.push(promise);
    return promise;
  }

  // Store data in the appropriate format using file-backed cache in this.store.
  onDataReady(resolve, reject, data) {
    this.logger.log('Storing data from ${Object.keys(this.urlsToFiles).length} URLs');
    const urlsToFiles = this.urlsToFiles;
    const urlsToParses = this.urlsToParses;
    return this.store.run({urlsToFiles, urlsToParses}).then(resolve, reject);
  }

  // Deal with glob-stream errors.
  onError(resolve, reject, error) {
    return reject(error);
  }
}

module.exports = BlinkLinkedRunner;