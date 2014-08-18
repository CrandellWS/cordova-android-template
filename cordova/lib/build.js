#!/usr/bin/env node

/*
       Licensed to the Apache Software Foundation (ASF) under one
       or more contributor license agreements.  See the NOTICE file
       distributed with this work for additional information
       regarding copyright ownership.  The ASF licenses this file
       to you under the Apache License, Version 2.0 (the
       "License"); you may not use this file except in compliance
       with the License.  You may obtain a copy of the License at

         http://www.apache.org/licenses/LICENSE-2.0

       Unless required by applicable law or agreed to in writing,
       software distributed under the License is distributed on an
       "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
       KIND, either express or implied.  See the License for the
       specific language governing permissions and limitations
       under the License.
*/

var shell   = require('shelljs'),
    spawn   = require('./spawn'),
    Q       = require('q'),
    path    = require('path'),
    fs      = require('fs'),
    ROOT    = path.join(__dirname, '..', '..');
var check_reqs = require('./check_reqs');

// Globals
var build_type,
    build_method;

function find_files(directory, predicate) {
    if (fs.existsSync(directory)) {
        var candidates = fs.readdirSync(directory).filter(predicate).map(function(p) {
            p = path.join(directory, p);
            return { p: p, t: fs.statSync(p).mtime };
        }).sort(function(a,b) {
            return a.t > b.t ? -1 :
                   a.t < b.t ? 1 : 0;
        }).map(function(p) { return p.p; });
        return candidates;
    } else {
        console.error('ERROR : unable to find project ' + directory + ' directory, could not locate .apk');
        process.exit(2);
    }
}

function hasCustomRules() {
    return fs.existsSync(path.join(ROOT, 'custom_rules.xml'));
}

module.exports.builders = {
    ant: {
        getArgs: function(cmd) {
            var args = [cmd, '-f', path.join(ROOT, 'build.xml')];
            // custom_rules.xml is required for incremental builds.
            if (hasCustomRules()) {
                args.push('-Dout.dir=ant-build', '-Dgen.absolute.dir=ant-gen');
            }
            try {
              // Specify sdk dir in case local properties are missing
              args.push('-Dsdk.dir='+path.join(which.sync('android'), '../..'));
            } catch(e) {
              // Can't find android; don't push arg: assume all is okay
            }
            return args;
        },

        /*
         * Builds the project with ant.
         * Returns a promise.
         */
        build: function(build_type) {
            var builder = this;
            var args = builder.getArgs(build_type == "debug" ? 'debug' : 'release');
            return Q().then(function() {
                return spawn('ant', args);
            }).then(function() {
                return builder.getOutputFiles();
            });
        },

        // Find the recently-generated output APK files
        // Ant only generates one output file; return it.
        getOutputFiles: function() {
            var binDir;
            if(hasCustomRules()) {
                binDir = path.join(ROOT, 'ant-build');
            } else {
                binDir = path.join(ROOT, 'bin');
            }
            var candidates = find_files(binDir, function(candidate) { return path.extname(candidate) == '.apk'; });
            if (candidates.length === 0) {
                console.error('ERROR : No .apk found in ' + binDir + ' directory');
                process.exit(2);
            }
            console.log('Using apk: ' + candidates[0]);
            return [candidates[0]];
        }
    },
    gradle: {
        getArgs: function(cmd) {
            var lintSteps = [
                'lint',
                'lintVitalRelease',
                'compileLint',
                'copyReleaseLint',
                'copyDebugLint'
            ];
            var args = [cmd, '-b', path.join(ROOT, 'build.gradle')];
            // 10 seconds -> 6 seconds
            args.push('-Dorg.gradle.daemon=true');
            // Excluding lint: 6s-> 1.6s
            for (var i = 0; i < lintSteps.length; ++i) {
                args.push('-x', lintSteps[i]);
            }
            // Shaves another 100ms, but produces a "try at own risk" warning. Not worth it (yet):
            // args.push('-Dorg.gradle.parallel=true');
            return args;
        },

        /*
         * Builds the project with gradle.
         * Returns a promise.
         */
        build: function(build_type) {
            var builder = this;
            var wrapper = path.join(ROOT, 'gradlew');
            var args = builder.getArgs('build');
            return Q().then(function() {
                return spawn(wrapper, args);
            }).then(function() {
                return builder.getOutputFiles(build_type);
            });
        },

        // Find the recently-generated output APK files
        // Gradle can generate multiple output files; return all of them.
        getOutputFiles: function(build_type) {
            var binDir = path.join(ROOT, 'build', 'apk');
            var candidates = find_files(binDir, function(candidate) {
                // Need to choose between release and debug .apk.
                if (build_type === 'debug') {
                    return (path.extname(candidate) == '.apk' && candidate.indexOf('-debug-') >= 0);
                }
                if (build_type === 'release') {
                    return (path.extname(candidate) == '.apk' && candidate.indexOf('-release-') >= 0);
                }
                return path.extname(candidate) == '.apk';
            });
            return candidates;
        }
    }
};

/*
 * Builds the project with the specifed options
 * Returns a promise.
 */
module.exports.run = function(options) {

    // Backwards-compatibility: Allow a single string argument
    if (typeof options == "string") options = [options];

    // Iterate through command line options
    for (var i=0; options && (i < options.length); ++i) {
        if (options[i].substring && options[i].substring(0,2) == "--") {
            var option = options[i].substring(2);
            switch(option) {
                case 'debug':
                case 'release':
                    if (build_type) {
                        return Q.reject('Multiple build types (' + build_type + ' and ' + option + ') specified.');
                    }
                    build_type = option;
                    break;
                case 'ant':
                case 'gradle':
                    if (build_method) {
                        return Q.reject('Multiple build methods (' + build_method + ' and ' + option + ') specified.');
                    }
                    build_method = option;
                    break;
                case 'nobuild' :
                    console.log('Skipping build...');
                    return Q();
                default :
                    return Q.reject('Build option \'' + options[i] + '\' not recognized.');
            }
        } else {
            return Q.reject('Build option \'' + options[i] + '\' not recognized.');
        }
    }
    // Defaults
    build_type = build_type || "debug";
    build_method = build_method || process.env.ANDROID_BUILD || "ant";

    // Get the builder
    var builder = module.exports.builders[build_method];

    // Without our custom_rules.xml, we need to clean before building.
    var ret;
    if (!hasCustomRules()) {
        // clean will call check_ant() for us.
        ret = require('./clean').run();
    } else {
        ret = check_reqs.check_ant();
    }

    // Return a promise for the actual build
    return ret.then(function() {
        return builder.build.call(builder, build_type);
    }).then(function(apkFiles) {
        var outputDir = path.join(ROOT, 'out');
        try {
            fs.mkdirSync(outputDir);
        } catch (e) {
            if (e.code != "EEXIST") {
                throw e;
            }
        }
        for (var i=0; i < apkFiles.length; ++i) {
            shell.cp('-f', apkFiles[i], path.join(outputDir, path.basename(apkFiles[i])));
        }
    });
};

/*
 * Gets the path to the apk file, if not such file exists then
 * the script will error out. (should we error or just return undefined?)
 * This is called by the run script to install the apk to the device
 */
module.exports.get_apk = function(build_type) {
    var outputDir = path.join(ROOT, 'out');
    var candidates = find_files(outputDir, function() { return true; });
    if (candidates.length === 0) {
        console.error('ERROR : No .apk found in ' + outputDir + ' directory');
        process.exit(2);
    }
    console.log('Using apk: ' + candidates[0]);
    return candidates[0];
};

module.exports.help = function() {
    console.log('Usage: ' + path.relative(process.cwd(), path.join(ROOT, 'cordova', 'build')) + ' [build_type]');
    console.log('Build Types : ');
    console.log('    \'--debug\': Default build, will build project in debug mode');
    console.log('    \'--release\': will build project for release');
    console.log('    \'--ant\': Default build, will build project with ant');
    console.log('    \'--gradle\': will build project with gradle');
    console.log('    \'--nobuild\': will skip build process (can be used with run command)');
    process.exit(0);
};
