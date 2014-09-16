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
var exec  = require('./exec');

var LOCAL_PROPERTIES_TEMPLATE =
    '# This file is automatically generated.\n' +
    '# Do not modify this file -- YOUR CHANGES WILL BE ERASED!\n';

function find_files(directory, predicate) {
    if (fs.existsSync(directory)) {
        var candidates = fs.readdirSync(directory).filter(predicate).map(function(p) {
            p = path.join(directory, p);
            return { p: p, t: fs.statSync(p).mtime };
        }).sort(function(a,b) {
            var timeDiff = b.t - a.t;
            if (timeDiff === 0) {
                return a.p.length - b.p.length;
            }
            return timeDiff;
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

function extractProjectNameFromManifest(projectPath) {
    var manifestPath = path.join(projectPath, 'AndroidManifest.xml');
    var manifestData = fs.readFileSync(manifestPath, 'utf8');
    var m = /<activity[\s\S]*?android:name\s*=\s*"(.*?)"/i.exec(manifestData);
    if (!m) {
        throw new Error('Could not find activity name in ' + manifestPath);
    }
    return m[1];
}

function extractSubProjectPaths() {
    var data = fs.readFileSync(path.join(ROOT, 'project.properties'), 'utf8');
    var ret = {};
    var r = /^\s*android\.library\.reference\.\d+=(.*)(?:\s|$)/mg
    var m;
    while (m = r.exec(data)) {
        ret[m[1]] = 1;
    }
    return Object.keys(ret);
}

var builders = {
    ant: {
        getArgs: function(cmd) {
            var args = [cmd, '-f', path.join(ROOT, 'build.xml')];
            // custom_rules.xml is required for incremental builds.
            if (hasCustomRules()) {
                args.push('-Dout.dir=ant-build', '-Dgen.absolute.dir=ant-gen');
            }
            return args;
        },

        prepEnv: function() {
            return check_reqs.check_ant()
            .then(function() {
                // Copy in build.xml on each build so that:
                // A) we don't require the Android SDK at project creation time, and
                // B) we always use the SDK's latest version of it.
                var sdkDir = process.env['ANDROID_HOME'];
                var buildTemplate = fs.readFileSync(path.join(sdkDir, 'tools', 'lib', 'build.template'), 'utf8');
                function writeBuildXml(projectPath) {
                    var newData = buildTemplate.replace('PROJECT_NAME', extractProjectNameFromManifest(ROOT));
                    fs.writeFileSync(path.join(projectPath, 'build.xml'), newData);
                    if (!fs.existsSync(path.join(projectPath, 'local.properties'))) {
                        fs.writeFileSync(path.join(projectPath, 'local.properties'), LOCAL_PROPERTIES_TEMPLATE);
                    }
                }
                var subProjects = extractSubProjectPaths();
                writeBuildXml(ROOT);
                for (var i = 0; i < subProjects.length; ++i) {
                    writeBuildXml(path.join(ROOT, subProjects[i]));
                }
            });
        },

        /*
         * Builds the project with ant.
         * Returns a promise.
         */
        build: function(build_type) {
            // Without our custom_rules.xml, we need to clean before building.
            var ret = Q();
            if (!hasCustomRules()) {
                // clean will call check_ant() for us.
                ret = this.clean();
            }

            var builder = this;
            var args = this.getArgs(build_type == 'debug' ? 'debug' : 'release');
            return check_reqs.check_ant()
            .then(function() {
                return spawn('ant', args);
            }).then(function() {
                return builder.getOutputFiles();
            });
        },

        clean: function() {
            var args = this.getArgs('clean');
            return check_reqs.check_ant()
            .then(function() {
                return spawn('ant', args);
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
            var ret = candidates[0];
            console.log('Using apk: ' + ret);
            return [ret];
        }
    },
    gradle: {
        getArgs: function(cmd) {
            var lintSteps;
            if (process.env['BUILD_MULTIPLE_APKS']) {
                lintSteps = [
                    'lint',
                    'lintVitalX86Release',
                    'lintVitalArmv7Release',
                    'compileLint',
                    'copyReleaseLint',
                    'copyDebugLint'
                ];
            } else {
                lintSteps = [
                    'lint',
                    'lintVitalRelease',
                    'compileLint',
                    'copyReleaseLint',
                    'copyDebugLint'
                ];
            }
            if (cmd == 'debug') {
                cmd = 'assembleDebug';
            } else if (cmd == 'release') {
                cmd = 'assembleRelease';
            }
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

        prepEnv: function() {
            return check_reqs.check_gradle()
            .then(function() {
                // Copy the gradle wrapper on each build so that:
                // A) we don't require the Android SDK at project creation time, and
                // B) we always use the SDK's latest version of it.
                var projectPath = ROOT;
                // check_reqs ensures that this is set.
                var sdkDir = process.env['ANDROID_HOME'];
                var wrapperDir = path.join(sdkDir, 'tools', 'templates', 'gradle', 'wrapper');
                if (process.platform == 'win32') {
                    shell.cp('-f', path.join(wrapperDir, 'gradlew.bat'), projectPath);
                } else {
                    shell.cp('-f', path.join(wrapperDir, 'gradlew'), projectPath);
                }
                shell.rm('-rf', path.join(projectPath, 'gradle', 'wrapper'));
                shell.mkdir('-p', path.join(projectPath, 'gradle'));
                shell.cp('-r', path.join(wrapperDir, 'gradle', 'wrapper'), path.join(projectPath, 'gradle'));
            });
        },

        /*
         * Builds the project with gradle.
         * Returns a promise.
         */
        build: function(build_type) {
            var builder = this;
            var wrapper = path.join(ROOT, 'gradlew');
            var args = this.getArgs(build_type == 'debug' ? 'debug' : 'release');
            return Q().then(function() {
                return spawn(wrapper, args);
            }).then(function() {
                return builder.getOutputFiles(build_type);
            });
        },

        clean: function() {
            var builder = this;
            var wrapper = path.join(ROOT, 'gradlew');
            var args = builder.getArgs('clean');
            return Q().then(function() {
                return spawn(wrapper, args);
            });
        },

        // Find the recently-generated output APK files
        // Gradle can generate multiple output files; return all of them.
        getOutputFiles: function(build_type) {
            var binDir = path.join(ROOT, 'build', 'outputs', 'apk');
            var candidates = find_files(binDir, function(candidate) {
                // Need to choose between release and debug .apk.
                if (build_type === 'debug') {
                    return (path.extname(candidate) == '.apk' && candidate.indexOf('-debug') >= 0);
                }
                if (build_type === 'release') {
                    return (path.extname(candidate) == '.apk' && candidate.indexOf('-release') >= 0);
                }
                return path.extname(candidate) == '.apk';
            });
            var ret = candidates[0];
            console.log('Using apk: ' + ret);
            return [ret];
        }
    },

    none: {
        prepEnv: function() {
            return Q();
        },
        build: function() {
            console.log('Skipping build...');
            return Q();
        },
        clean: function() {
            return Q();
        },
    }
};

function parseOpts(options) {
    // Backwards-compatibility: Allow a single string argument
    if (typeof options == "string") options = [options];

    var ret = {
        buildType: 'debug',
        buildMethod: process.env['ANDROID_BUILD'] || 'ant'
    };

    // Iterate through command line options
    for (var i=0; options && (i < options.length); ++i) {
        if (options[i].substring && options[i].substring(0,2) == "--") {
            var option = options[i].substring(2);
            switch(option) {
                case 'debug':
                case 'release':
                    ret.buildType = option;
                    break;
                case 'ant':
                case 'gradle':
                    ret.buildMethod = option;
                    break;
                case 'nobuild' :
                    ret.buildMethod = 'none';
                    break;
                default :
                    return Q.reject('Build option \'' + options[i] + '\' not recognized.');
            }
        } else {
            return Q.reject('Build option \'' + options[i] + '\' not recognized.');
        }
    }
    return ret;
}

/*
 * Builds the project with the specifed options
 * Returns a promise.
 */
module.exports.runClean = function(options) {
    var opts = parseOpts(options);
    var builder = builders[opts.buildMethod];
    return builder.prepEnv()
    .then(function() {
        return builder.clean();
    }).then(function() {
        shell.rm('-rf', path.join(ROOT, 'out'));
    });
};

/*
 * Builds the project with the specifed options
 * Returns a promise.
 */
module.exports.run = function(options) {
    var opts = parseOpts(options);

    var builder = builders[opts.buildMethod];
    return builder.prepEnv()
    .then(function() {
        return builder.build(opts.buildType);
    }).then(function(apkFiles) {
        // TODO: Rather than copy apks to out, it might be better to
        // just write out what the last .apk build was. These files
        // are used by get_apk().
        var outputDir = path.join(ROOT, 'out');
        shell.mkdir('-p', outputDir);
        for (var i=0; i < apkFiles.length; ++i) {
            shell.cp('-f', apkFiles[i], path.join(outputDir, path.basename(apkFiles[i])));
        }
    });
};

/*
 * Detects the architecture of a device/emulator
 * Returns "arm" or "x86".
 */
module.exports.detectArchitecture = function(target) {
    return exec('adb -s ' + target + ' shell cat /proc/cpuinfo')
    .then(function(output) {
        if (/intel/i.exec(output)) {
            return 'x86';
        }
        return 'arm';
    });
};

/*
 * Gets the path to the apk file, if not such file exists then
 * the script will error out. (should we error or just return undefined?)
 * This is called by the run script to install the apk to the device
 */
module.exports.get_apk = function(build_type, architecture) {
    var outputDir = path.join(ROOT, 'out');
    var candidates = find_files(outputDir, function(filename) { return (!architecture) || filename.indexOf(architecture) >= 0; });
    if (candidates.length === 0) {
        console.error('ERROR : No .apk found in ' + outputDir + ' directory');
        process.exit(2);
    }
    // TODO: Use build_type here.
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
