/**
 * @typedef {Object}   ProgressMessage
 * @typedef {Number}   ProgressMessage.progress (float number)
 * @typedef {File}     ProgressMessage.file
 */

/**
 * @typedef {Object}   StartMessage
 * @typedef {Boolean}  StartMessage.start always true
 * @typedef {File}     ProgressMessage.file
 */

/**
 * @typedef {Object}   ErrorMessage
 * @typedef {Error}    ErrorMessage.error
 * @typedef {File}     EndMessage.file
 */

/**
 * @typedef {Object}   EndMessage
 * @typedef {String}   EndMessage.end hash of the file
 * @typedef {File}     EndMessage.file
 */

;(function (root, factory) {
    root.woleet = factory(root.woleet)
})(window, function (woleet) {

    const api = woleet || {};
    api.file = api.file || {};

    const isHTTPS = location.protocol == 'https:';

    //noinspection JSUnresolvedVariable
    const testNativeCryptoSupport = window.crypto && window.crypto.subtle && window.crypto.subtle.digest && isHTTPS;

    const testFileReaderSupport = checkFileReaderSyncSupport();

    /**
     * @returns {String} get the base path (including final '/') of the current script.
     */
    function findBasePath() {
        let scripts = document.getElementsByTagName('script');
        let scriptsArray = Array.prototype.slice.call(scripts, 0); // Converts collection to array
        let regex = /.*woleet-(hashfile|weblibs)[.min]*\.js$/;
        let script = scriptsArray.find((script) => script.src && script.src.match(regex));
        return script && script.src ? script.src.substr(0, script.src.lastIndexOf("/") + 1) : null;
    }

    // Guess the path of the worker script: same as current script's or defined by woleet.workerScriptPath
    let basePath = findBasePath();
    let DEFAULT_WORKER_SCRIPT = "woleet-hashfile-worker.min.js";
    //noinspection JSUnresolvedVariable
    let workerScriptPath = (api.workerScriptPath || (basePath ? basePath + DEFAULT_WORKER_SCRIPT : null));
    if (!workerScriptPath)
        throw new Error('Cannot find ' + DEFAULT_WORKER_SCRIPT);

    /**
     * Check support for workers.
     */
    function checkFileReaderSyncSupport() {

        function makeWorker(script) {
            //noinspection JSUnresolvedVariable
            let URL = window.URL || window.webkitURL;
            let Blob = window.Blob;
            let Worker = window.Worker;

            if (!URL || !Blob || !Worker || !script) return null;

            let blob = new Blob([script]);
            //noinspection JSUnresolvedFunction
            return new Worker(URL.createObjectURL(blob));
        }

        return new Promise(function (resolve) {
            let syncDetectionScript = "onmessage = function(e) { postMessage(!!FileReaderSync); };";
            try {
                let worker = makeWorker(syncDetectionScript);
                if (worker) {
                    worker.onmessage = function (e) {
                        resolve(e.data);
                    };
                    worker.postMessage({});
                }
                else resolve(false);
            } catch (err) {
                resolve(false);
            }
        });
    }

    api.file.Hasher = function () {

        let ready = true;
        let cb_start, cb_progress, cb_result, cb_error;

        /**
         * @param {String} event
         * @param {Function} callback
         */
        this.on = function (event, callback) {
            switch (event) {
                case 'start':
                    cb_start = callback;
                    break;
                case 'progress':
                    cb_progress = callback;
                    break;
                case 'error':
                    cb_error = callback;
                    break;
                case 'result':
                    cb_result = callback;
                    break;
                default:
                    throw new Error('Invalid event name "' + event + '"');
            }
        };

        /**
         * @constructor
         */
        const HashWorker = function () {

            let worker = new Worker(workerScriptPath);

            /**
             * @param {File} file
             * @returns {Promise}
             */
            this.hash = function (file) {
                return new Promise((next, reject) => {

                    worker.onmessage = function (message) {//handling worker message
                        if (message.data.progress != undefined) {
                            if (cb_progress) cb_progress(message.data);
                        }
                        else if (message.data.result) {
                            if (cb_result) cb_result(message.data);
                            next(worker);
                        }
                        else if (message.data.start) {
                            if (cb_start) cb_start(message.data);
                        }
                        else if (message.data.error) {
                            let error = message.data.error;
                            if (cb_error) cb_error(error);
                            else reject(error);
                        }
                        else {
                            console.trace("Unexpected worker message: ", message);
                        }
                    };

                    worker.postMessage(file);
                });
            };

        };

        /**
         * @param {File} file
         * @returns {Promise}
         */
        const hashLocal = function (file) {

            return new Promise((next, reject) => {
                let error = new Error("file_too_big_to_be_hashed_without_worker");
                if (file.size > 5e7) {
                    ready = true;
                    if (cb_error) return cb_error({error: error, file: file});
                    else reject(error);
                }

                let reader = new FileReader();

                let sha256 = CryptoJS.algo.SHA256.create();
                let hash, prev = 0;

                reader.onloadstart = () => {
                    if (cb_start) cb_start({start: true, file: file});
                };

                reader.onloadend = () => {
                    hash.finalize();
                    if (cb_result) cb_result({
                        result: hash._hash.toString(CryptoJS.enc.Hex),
                        file: file
                    });
                    next();
                };

                reader.onprogress = (e) => {
                    //noinspection JSUnresolvedVariable
                    /** @type ArrayBuffer */
                    let buf = e.target.result;
                    //noinspection JSUnresolvedVariable
                    let blob = buf.slice(prev, e.loaded);
                    let chunkUint8 = new Uint8Array(blob);
                    let wordArr = CryptoJS.lib.WordArray.create(chunkUint8);
                    hash = sha256.update(wordArr);
                    //noinspection JSUnresolvedVariable
                    prev = e.loaded;
                    if (cb_progress) {
                        //noinspection JSUnresolvedVariable
                        cb_progress({progress: (e.loaded / e.total), file: file});
                    }
                };

                reader.readAsArrayBuffer(file);
            });
        };

        /**
         * @param {File} file
         * @returns {Promise}
         */
        const hashLocalWithNativeAPI = function (file) {
            return new Promise((resolve, reject) => {
                let algo = "SHA-256";
                // entry point
                let reader = new FileReader();

                reader.onloadstart = () => {
                    if (cb_start) cb_start({start: true, file: file});
                };

                reader.onprogress = (e) => {
                    if (cb_progress) { //noinspection JSUnresolvedVariable
                        cb_progress({progress: (e.loaded / e.total), file: file});
                    }
                };

                reader.onload = function (event) {
                    let data = event.target.result;
                    //noinspection JSUnresolvedFunction,JSUnresolvedVariable
                    window.crypto.subtle.digest(algo, data)
                        .then(function (hash) {
                            let hashResult = new Uint8Array(hash);
                            let hexString = hashResult.reduce((res, e) => res + ('00' + e.toString(16)).slice(-2), '');
                            if (cb_result) cb_result({result: hexString, file: file});
                            resolve();
                        })
                        .catch((error) => cb_error ? cb_error({error: error, file: file}) : reject(error));
                };

                reader.readAsArrayBuffer(file);
            })
        };

        this.start = function (files) {

            const max_native_crypto_size = 5e8; // ~500MB

            let hashWorker = null; // We may have to keep the hashWorker

            if (!ready) throw new Error("not_ready");

            ready = false;

            // checking input type
            if (!(files instanceof FileList || files instanceof File))
                throw new Error("invalid_parameter");

            testFileReaderSupport
                .then((WorkerSupported) => {

                    /**
                     * iterator function with selected hash method
                     * @param {Number} i current index of the list
                     * @param {Number} len total size of the list
                     * @param {FileList|[File]} files file list
                     * @param {Worker} [worker] passing worker through iterator if selected method is hashWorker in order to terminate it
                     */
                    function iter(i, len, files, worker) {

                        if ((i >= len)) {
                            ready = true;
                            if (worker) worker.terminate();
                        }
                        else {

                            // We choose here the better method to hash a file
                            let hashMethod = null;
                            if (testNativeCryptoSupport && files[i].size < max_native_crypto_size) {
                                hashMethod = hashLocalWithNativeAPI;
                            }
                            else if (WorkerSupported) {
                                if (!hashWorker) hashWorker = new HashWorker(); // if worker instance has already been called
                                hashMethod = hashWorker.hash;
                            }
                            else if (typeof CryptoJS !== 'undefined') {
                                hashMethod = hashLocal;
                            }
                            else {
                                throw new Error("no_viable_hash_method");
                            }

                            hashMethod(files[i]).then((_worker) => {
                                iter(i + 1, len, files, _worker || worker);
                            })
                        }
                    }

                    // entry point
                    if (files instanceof FileList) { // files is a FileList
                        iter(0, files.length, files);
                    }
                    else if (files instanceof File) { // files is a single file
                        iter(0, 1, [files]);
                    }
                })

        };

        this.isReady = function () {
            return ready;
        };
    };

    /**
     * @param {File|String} file
     * @param {Function} [progressCallback]
     * @returns {Promise<Hash>}
     */
    api.hashFileOrCheckHash = (file, progressCallback) => {
        return new Promise((resolve, reject) => {

            // If parameter is a file, hash it
            if (file instanceof File) {

                if (!api.file || !api.file.Hasher)
                    throw new Error("missing_woleet_hash_dependency");

                const hasher = new api.file.Hasher;

                hasher.on('result', (message, file) => {
                    resolve(message.result);
                    if (progressCallback)
                        progressCallback({progress: 1.0, file: file})
                });

                if (progressCallback && typeof progressCallback == 'function')
                    hasher.on('progress', progressCallback);

                hasher.on('error', reject);

                hasher.start(file)
            }

            // If parameter is a hash, check it is a valid SHA256 hash
            else if (typeof file == "string") {
                if (api.isSHA256(file))
                    resolve(file);
                else
                    reject(new Error("parameter_string_not_a_sha256_hash"));
            }

            // Invalid parameter
            else
                reject(new Error("invalid_parameter"));
        });
    };

    return api;
});