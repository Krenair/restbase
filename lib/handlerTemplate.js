'use strict';

/*
 * A backend request handler definition template, that compiles a handler spec
 * into an executable function.
 */

var P = require('bluebird');
var URI = require('swagger-router').URI;
var rbUtil = require('../lib/rbUtil');
var Template = require('../lib/reqTemplate');

function generatePromiseChain(restbase, context, requestChain) {
    var promise;
    var currentRequestSpec = requestChain[0];
    if (currentRequestSpec.length > 1) {
        promise = P.all(currentRequestSpec.map(function(spec) {
            return spec.request(restbase, context);
        }));
    } else if (currentRequestSpec[0].request) {
        promise = currentRequestSpec[0].request(restbase, context);
    }

    if (currentRequestSpec[0].return) {
        promise = promise || P.resolve();
        promise = promise.then(currentRequestSpec[0].return(context));
    }

    if (currentRequestSpec[0].catch) {
        promise = promise.catch(function(err) {
            if (!currentRequestSpec[0].catch(err)) {
                throw err;
            }
        });
    }
    promise = promise || P.resolve();
    if (requestChain.length === 1) {
        return promise;
    } else if (currentRequestSpec[0].return_if) {
        return promise.then(function(res) {
            if (res && currentRequestSpec[0].return_if(res)) {
                return res;
            } else {
                return generatePromiseChain(restbase, context, requestChain.slice(1));
            }
        });
    } else {
        return promise.then(function() {
            return generatePromiseChain(restbase, context, requestChain.slice(1));
        });
    }
}

/**
 * Creates a JS function that verifies property equality
 *
 * @param catchDefinition the condition in the format of 'catch' and 'return_if' stanza
 * @returns {Function} a function that verifies the condition
 */
function compileCatchFunction(catchDefinition) {
    function createCondition(catchCond, option) {
        var opt = option.toString();
        if (catchCond === 'status') {
            if (/^[0-9]+$/.test(opt)) {
                return '(res["' + catchCond + '"] === ' + opt + ')';
            } else if (/^[0-9x]+$/.test(opt)) {
                return 'Array.isArray(res["' + catchCond
                    + '"].toString().match(/^' + opt.replace(/x/g, "\\d")
                    + '$/))';
            } else {
                throw new Error('Invalid condition ' + opt);
            }
        } else {
            return '(res["' + catchCond + '"] === ' + opt + ')';
        }
    }

    var condition = [];
    var code;
    Object.keys(catchDefinition).forEach(function(catchCond) {
        if (Array.isArray(catchDefinition[catchCond])) {
            var orCondition = catchDefinition[catchCond].map(function(option) {
                return createCondition(catchCond, option);
            });
            condition.push('(' + orCondition.join(' || ') + ')');
        } else {
            condition.push(createCondition(catchCond, catchDefinition[catchCond]));
        }
    });
    code = 'return (' + condition.join(' && ') + ');';
    /* jslint evil: true */
    return new Function('res', code);
}

/**
 * Checks if a step definition contains 'return' or 'return_if' stanza
 * @param stepConf step config object
 * @returns {boolean} true if there's 'return' or 'return_if' in the step
 */
function isReturnStep(stepConf) {
    return Object.keys(stepConf).some(function(requestName) {
        return stepConf[requestName].return || stepConf[requestName].return_if;
    });
}

/**
 * Validates a single step in the request chain
 *
 * @param {object} stepConf step configuration with optional
 *                 'request', 'return', 'return_if' and 'catch' properties.
 */
function validateStep(stepConf) {
    // Returning steps can't be parallel
    if (isReturnStep(stepConf) && Object.keys(stepConf).length > 1) {
        throw new Error('Invalid spec. ' +
        'Returning requests cannot be parallel. Spec: ' + JSON.stringify(stepConf));
    }

    // Either 'request' or 'return' must be specified
    if (!Object.keys(stepConf).every(function(requestName) {
        return stepConf[requestName].request || stepConf[requestName].return;
    })) {
        throw new Error('Invalid spec. ' +
        'Either request or return must be specified. Step: ' + JSON.stringify(stepConf));
    }

    // Only supply 'return_if' when 'request' is specified
    if (Object.keys(stepConf).some(function(requestName) {
        return stepConf[requestName].return_if && !stepConf[requestName].request;
    })) {
        throw new Error('Invalid spec. ' +
        'return_if should have a matching request. Step: ' + JSON.stringify(stepConf));
    }

    // Only supply 'catch' when 'request' is specified
    if (Object.keys(stepConf).some(function(requestName) {
        return stepConf[requestName].catch && !stepConf[requestName].request;
    })) {
        throw new Error('Invalid spec. ' +
        'catch should have a matching request. Step: ' + JSON.stringify(stepConf));
    }
}

/**
 * Validates the specification of the service,
 * throws Error if some of the rules are not met.
 *
 * Current rules:
 *  - request handler spec must be an array
 *  - returning steps can't be parallel
 *  - either 'request' or 'return' must be specified in each step
 *  - 'return_if' is allowed only if 'request' is specified in a step
 *  - 'catch' is allowed only if 'request' is specified in a step
 *  - last step in a request chain can't be parallel
 *
 * @param {object} spec service spec object
 */
function validateSpec(spec) {
    if (!spec || !Array.isArray(spec)) {
        throw new Error('Invalid spec. It must be an array of request block definitions.' +
            ' Spec: ' + JSON.stringify(spec));
    }
    spec.forEach(validateStep);

    // Last step must not be parallel
    if (Object.keys(spec[spec.length - 1]).length > 1) {
        throw new Error('Invalid spec. The last step in chain must not be parallel.');
    }
}

/**
 * Prepares a request chain on startup: compiles request/response templates,
 * creates catch conditions verifiers.
 * @param conf request chain configuration
 *
 * @returns {Array} an array of prepared steps, each containing a
 *                  request function generator
 */
function prepareRequestChain(conf) {

    /**
     * Creates a function generator that returns a closure to execute in order to
     * make a request
     * @param requestSpec request spec object, the result would be added there under
     *        a request property
     * @param requestName a name of the request, the result would be added to the
     *        context under this name
     * @param requestConf request configuration object containing a request template
     */
    function prepareRequest(requestSpec, requestName, requestConf) {
        var template;
        if (requestConf.request) {
            template = new Template(requestConf.request);
            requestSpec.request = function(restbase, context) {
                var req = template.eval(context);
                return restbase.request(req)
                .then(function(res) {
                    context[requestName] = res;
                    return res;
                });
            };
        }
    }

    function prepareReturn(requestSpec, requestConf) {
        if (requestConf.return) {
            var template = new Template(requestConf.return);
            var originalRequestHandler = requestSpec.request;
            if (originalRequestHandler) {
                requestSpec.request = function(restbase, context) {
                    return originalRequestHandler(restbase, context)
                    .then(function() {
                        return template.eval(context);
                    });
                };
            } else {
                requestSpec.request = function(restbase, context) {
                    return template.eval(context);
                };
            }
        }
    }

    function prepareCatch(requestSpec, requestConf) {
        if (requestConf.catch) {
            var isCaught = compileCatchFunction(requestConf.catch);
            var originalRequestHandler = requestSpec.request;
            requestSpec.request = function(restbase, context) {
                return originalRequestHandler(restbase, context)
                .catch(function(err) {
                    if (!isCaught(err)) {
                        throw err;
                    }
                });
            };
        }
    }

    function prepareReturnIf(requestSpec, requestConf) {
        if (requestConf.return_if) {
            requestSpec.return_if = compileCatchFunction(requestConf.return_if);
        }
    }

    return conf.map(function(stepConf) {
        return Object.keys(stepConf).map(function(requestName) {
            var requestConf = stepConf[requestName];
            var requestSpec = { name: requestName };
            prepareRequest(requestSpec, requestName, requestConf);
            prepareReturn(requestSpec, requestConf);
            prepareReturnIf(requestSpec, requestConf);
            prepareCatch(requestSpec, requestConf);
            return requestSpec;
        });
    });
}

/**
 * Creates a handler function from the handler spec.
 *
 * @param spec - a request handler spec
 * @returns {Function} a request handler
 */
function createHandler(spec) {
    validateSpec(spec);
    var requestChain = prepareRequestChain(spec);
    return function(restbase, req) {
        return generatePromiseChain(restbase, {
            request: req
        }, requestChain);
    };
}

/**
 * Processes an x-setup-handler config and returns all resources
 *
 * @param {object} setupConf an endpoint configuration object
 */
function parseSetupConfig(setupConf) {
    var result = [];
    if (Array.isArray(setupConf)) {
        setupConf.forEach(function(resourceSpec) {
            Object.keys(resourceSpec).forEach(function(requestName) {
                var requestSpec = resourceSpec[requestName];
                requestSpec.method = requestSpec.method || 'put';
                result.push(requestSpec);
            });
        });
    } else {
        throw new Error('Invalid config. x-setup-handler must be an array');
    }
    return result;
}

module.exports = {
    createHandler: createHandler,
    parseSetupConfig: parseSetupConfig
};

