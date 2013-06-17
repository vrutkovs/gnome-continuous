// Copyright (C) 2012,2013 Colin Walters <walters@verbum.org>
//
// This library is free software; you can redistribute it and/or
// modify it under the terms of the GNU Lesser General Public
// License as published by the Free Software Foundation; either
// version 2 of the License, or (at your option) any later version.
//
// This library is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
// Lesser General Public License for more details.
//
// You should have received a copy of the GNU Lesser General Public
// License along with this library; if not, write to the
// Free Software Foundation, Inc., 59 Temple Place - Suite 330,
// Boston, MA 02111-1307, USA.

const GLib = imports.gi.GLib;
const Gio = imports.gi.Gio;
const format = imports.format;
const Lang = imports.lang;
const Signals = imports.signals;

const GSystem = imports.gi.GSystem;
const Params = imports.params;
const JsonUtil = imports.jsonutil;
const JsonDB = imports.jsondb;
const ProcUtil = imports.procutil;
const BuildUtil = imports.buildutil;
const VersionedDir = imports.versioneddir;

const DefaultTaskDef = {
    TaskName: '',
    TaskAfter: [],
    TaskScheduleMinSecs: 0,

    PreserveStdout: true,
    RetainFailed: 5,
    RetainSuccess: 5,
};

var _tasksetInstance = null;
const TaskSet = new Lang.Class({
    Name: 'TaskSet',
    
    _init: function() {
	this._tasks = [];
	let taskdir = Gio.File.new_for_path(GLib.getenv('OSTBUILD_DATADIR')).resolve_relative_path('js/tasks');
	let denum = taskdir.enumerate_children('standard::*', 0, null);
	let finfo;
	
	for (let taskmodname in imports.tasks) {
	    let taskMod = imports.tasks[taskmodname];
	    for (let defname in taskMod) {
		if (defname.indexOf('Task') !== 0
		    || defname == 'Task')
		    continue;
		let cls = taskMod[defname];
		this.register(cls);
	    }
	}

	denum.close(null);
    },

    register: function(task) {
	this._tasks.push(task);
    },

    getAllTasks: function() {
	return this._tasks;
    },

    getTask: function(taskName) {
	for (let i = 0; i < this._tasks.length; i++) {
	    let taskConstructor = this._tasks[i];
	    let taskDef = taskConstructor.prototype.TaskDef;
	    let curName = taskDef.TaskName;
	    if (curName == taskName)
		return taskConstructor;
	}
	throw new Error("No task definition matches " + taskName);
    },

    getTaskDef: function(taskName) {
	let taskDef = this.getTask(taskName).prototype.TaskDef;
	return Params.parse(taskDef, DefaultTaskDef);
    },

    getInstance: function() {
	if (!_tasksetInstance)
	    _tasksetInstance = new TaskSet();
	return _tasksetInstance;
    },

    getTasksAfter: function(taskName) {
	let ret = [];
	for (let i = 0; i < this._tasks.length; i++) {
	    let taskConstructor = this._tasks[i];
	    let taskDef = Params.parse(taskConstructor.prototype.TaskDef, DefaultTaskDef);
	    let after = taskDef.TaskAfter;
	    for (let j = 0; j < after.length; j++) {
		let a = after[j];
		if (a == taskName) {
		    ret.push(taskDef.TaskName);
		    break;
		}
	    }
	}
	return ret;
    }
});

const TaskData = new Lang.Class({
    Name: 'TaskData',

    _init: function(taskDef, parameters) {
	this.name = taskDef.TaskName;
	this.taskDef = taskDef;
	this.parameters = parameters;
    },
});
    
const TaskMaster = new Lang.Class({
    Name: 'TaskMaster',

    _init: function(path, params) {
        params = Params.parse(params, { onEmpty: null, 
				        processAfter: true,
				        skip: [] });
	this.path = path;
	this._processAfter = params.processAfter;
	this._skipTasks = {};
	for (let i = 0; i < params.skip.length; i++)
	    this._skipTasks[params.skip[i]] = true;
	this.maxConcurrent = GLib.get_num_processors();
	this._onEmpty = params.onEmpty;
	this.cancellable = null;
	this._idleRecalculateId = 0;
	this._executing = [];
	this._pendingTasksList = [];
	this._seenTasks = {};
	this._taskErrors = {};
	this._caughtError = false;

	this._taskset = TaskSet.prototype.getInstance();

	// string -> [ lastExecutedSecs, taskData ]
	this._scheduledTaskTimeouts = {};
    },

    _pushTaskDataImmediate: function(taskData) {
	this._pendingTasksList.push(taskData);
	this._queueRecalculate();
    },

    pushTask: function(name, parameters) {
	let taskDef = this._taskset.getTaskDef(name);
        let taskData = new TaskData(taskDef, parameters);
	if (!this._isTaskPending(name)) {
	    let scheduleMinSecs = taskDef.TaskScheduleMinSecs;
	    if (scheduleMinSecs > 0) {
		let info = this._scheduledTaskTimeouts[name];
		if (!info) {
		    info = [ 0, null ];
		    this._scheduledTaskTimeouts[name] = info;
		}
		let lastExecutedSecs = info[0];
		let pendingExecData = info[1];
		let currentTime = GLib.get_monotonic_time() / GLib.USEC_PER_SEC;
		if (pendingExecData != null) {
		    // Nothing, already scheduled
                    let delta = (lastExecutedSecs + scheduleMinSecs) - currentTime;
		    print("Already scheduled task " + name + " remaining=" + delta);
		} else if (lastExecutedSecs == 0) {
		    print("Scheduled task " + name + " executing immediately");
		    this._pushTaskDataImmediate(taskData);
		    info[0] = currentTime;
                } else {
                    let delta = (lastExecutedSecs + scheduleMinSecs) - currentTime;
		    print("Scheduled task " + name + " delta=" + delta);
		    let timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT,
							     Math.max(delta, 0),
							     Lang.bind(this, this._executeScheduledTask, name));
		    info[0] = currentTime;
		    info[1] = taskData;
		}
	    } else {
		this._pushTaskDataImmediate(taskData);
	    }
	}
    },
    
    _executeScheduledTask: function(name) {
	print("Executing scheduled task " + name);
	let currentTime = GLib.get_monotonic_time() / GLib.USEC_PER_SEC;
	let info = this._scheduledTaskTimeouts[name];
        let taskData = info[1];
	info[0] = currentTime;
	info[1] = null;
	this._pushTaskDataImmediate(taskData);
    },

    _isTaskPending: function(taskName) {
	for (let i = 0; i < this._pendingTasksList.length; i++) {
	    let pending = this._pendingTasksList[i];
	    if (pending.name == taskName)
		return true;
	}
	return false;
    },

    isTaskQueued: function(taskName) {
	return this._isTaskPending(taskName) || this.isTaskExecuting(taskName);
    },

    isTaskExecuting: function(taskName) {
	for (let i = 0; i < this._executing.length; i++) {
	    let executingRunner = this._executing[i];
	    if (executingRunner.taskData.name == taskName)
		return true;
	}
	return false;
    },

    getTaskState: function() {
	let r = [];
	for (let i = 0; i < this._pendingTasksList.length; i++) {
	    r.push({running: false, task: this._pendingTasksList[i] });
	}
	for (let i = 0; i < this._executing.length; i++) {
	    r.push({running: true, task: this._executing[i] });
	}
	return r;
    },

    _queueRecalculate: function() {
	if (this._idleRecalculateId > 0)
	    return;
	this._idleRecalculateId = GLib.idle_add(GLib.PRIORITY_DEFAULT, Lang.bind(this, this._recalculate));
    },

    _recalculate: function() {
	this._idleRecalculateId = 0;

	if (this._executing.length == 0 &&
	    this._pendingTasksList.length == 0) {
	    this._onEmpty(true, null);
	    return;
	} else if (this._pendingTasksList.length == 0) {
	    return;
	}

	let notExecuting = [];
	let executing = [];
	for (let i = 0; i < this._pendingTasksList.length; i++) {
	    let pending = this._pendingTasksList[i];
	    if (this.isTaskExecuting(pending.name))
		executing.push(pending);
	    else
		notExecuting.push(pending);
	}

	this._pendingTasksList = notExecuting.concat(executing);

	this._reschedule();
    },

    _onComplete: function(success, error, runner) {
	let idx = -1;
	for (let i = 0; i < this._executing.length; i++) {
	    let executingRunner = this._executing[i];
	    if (executingRunner !== runner)
		continue;
	    idx = i;
	    break;
	}
	if (idx == -1)
	    throw new Error("TaskMaster: Internal error - Failed to find completed task:" + runner.taskData.name);
	this._executing.splice(idx, 1);
	this.emit('task-complete', runner, success, error);
	if (success && this._processAfter) {
	    if (runner.changed) {
		let taskName = runner.taskData.name;
		let taskDef = runner.taskData.taskDef;
		let after = this._taskset.getTasksAfter(taskName);
		for (let i = 0; i < after.length; i++) {
		    let afterTaskName = after[i];
		    if (!this._skipTasks[afterTaskName])
			this.pushTask(afterTaskName, {});
		}
	    }
	}
	this._queueRecalculate();
    },

    _reschedule: function() {
	while (this._executing.length < this.maxConcurrent &&
	       this._pendingTasksList.length > 0 &&
	       !this.isTaskExecuting(this._pendingTasksList[0].name)) {
	    let task = this._pendingTasksList.shift();
	    let runner = new TaskRunner(this, task, Lang.bind(this, function(success, error) {
		this._onComplete(success, error, runner);
	    }));
	    runner.executeInSubprocess(this.cancellable);
	    this._executing.push(runner);
	    this.emit('task-executing', runner);
	}
    }
});
Signals.addSignalMethods(TaskMaster.prototype);

const Task = new Lang.Class({
    Name: 'Task',

    DefaultParameters: {},

    _init: function(parameters) {
        this.name = this.TaskName;
	this.parameters = Params.parse(parameters, this.DefaultParameters);

	this.workdir = Gio.File.new_for_path(GLib.getenv('_OSTBUILD_WORKDIR'));
	BuildUtil.checkIsWorkDirectory(this.workdir);

	this.resultdir = this.workdir.get_child('results');
	GSystem.file_ensure_directory(this.resultdir, true, null);
	this.mirrordir = this.workdir.get_child('src');
	GSystem.file_ensure_directory(this.mirrordir, true, null);
	this.cachedir = this.workdir.resolve_relative_path('cache/raw');
	GSystem.file_ensure_directory(this.cachedir, true, null);

	this.libdir = Gio.File.new_for_path(GLib.getenv('OSTBUILD_LIBDIR'));
	this.repo = this.workdir.get_child('repo');
    },

    _getResultDb: function(taskname) {
	let path = this.resultdir.resolve_relative_path(taskname);
	return new JsonDB.JsonDB(path);
    },

    execute: function(cancellable) {
	throw new Error("Not implemented");
    },
});

const TaskRunner = new Lang.Class({
    Name: 'TaskRunner',

    _VERSION_RE: /^(\d+\d\d\d\d)\.(\d+)$/,

    _init: function(taskmaster, taskData, onComplete) {
	this.taskmaster = taskmaster;
	this.taskData = taskData;
	this.onComplete = onComplete;
        this.name = taskData.name;

	this.workdir = taskmaster.path.get_parent();
	BuildUtil.checkIsWorkDirectory(this.workdir);
    },

    _loadAllVersions: function(cancellable) {
	let allVersions = [];

	let successVersions = this._successDir.loadVersions(cancellable);
	for (let i = 0; i < successVersions.length; i++) {
	    allVersions.push([true, successVersions[i]]);
	}

	let failedVersions = this._failedDir.loadVersions(cancellable);
	for (let i = 0; i < failedVersions.length; i++) {
	    allVersions.push([false, failedVersions[i]]);
	}

	allVersions.sort(function (a, b) {
	    let [successA, versionA] = a;
	    let [successB, versionB] = b;
	    return BuildUtil.compareVersions(versionA, versionB);
	});

	return allVersions;
    },

    executeInSubprocess: function(cancellable) {
	this._cancellable = cancellable;

	this._startTimeMillis = GLib.get_monotonic_time() / 1000;

	this.dir = this.taskmaster.path.resolve_relative_path(this.name);
	GSystem.file_ensure_directory(this.dir, true, cancellable);
	
	this._topDir = new VersionedDir.VersionedDir(this.dir, this._VERSION_RE);
	this._successDir = new VersionedDir.VersionedDir(this.dir.get_child('successful'),
							 this._VERSION_RE);
	this._failedDir = new VersionedDir.VersionedDir(this.dir.get_child('failed'),
							this._VERSION_RE);

	let allVersions = this._loadAllVersions(cancellable);

	let currentTime = GLib.DateTime.new_now_utc();

	let currentYmd = Format.vprintf('%d%02d%02d', [currentTime.get_year(),
						       currentTime.get_month(),
						       currentTime.get_day_of_month()]);
	let version = null;
	if (allVersions.length > 0) {
	    let [lastSuccess, lastVersion] = allVersions[allVersions.length-1];
	    let match = this._VERSION_RE.exec(lastVersion);
	    if (!match) throw new Error();
	    let lastYmd = match[1];
	    let lastSerial = match[2];
	    if (lastYmd == currentYmd) {
		version = currentYmd + '.' + (parseInt(lastSerial) + 1);
	    }
	}
	if (version === null) {
	    version = currentYmd + '.0';
	}

	this._version = version;
	this._taskCwd = this.dir.get_child(version);
	GSystem.shutil_rm_rf(this._taskCwd, cancellable);
	GSystem.file_ensure_directory(this._taskCwd, true, cancellable);

	let baseArgv = ['ostbuild', 'run-task', this.name, JSON.stringify(this.taskData.parameters)];
	let context = new GSystem.SubprocessContext({ argv: baseArgv });
	context.set_cwd(this._taskCwd.get_path());
	let childEnv = GLib.get_environ();
	childEnv.push('_OSTBUILD_WORKDIR=' + this.workdir.get_path());
	context.set_environment(childEnv);
	if (this.taskData.taskDef.PreserveStdout) {
	    let outPath = this._taskCwd.get_child('output.txt');
	    context.set_stdout_file_path(outPath.get_path());
	    context.set_stderr_disposition(GSystem.SubprocessStreamDisposition.STDERR_MERGE);
	} else {
	    context.set_stdout_disposition(GSystem.SubprocessStreamDisposition.NULL);
	    let errPath = this._taskCwd.get_child('errors.txt');
	    context.set_stderr_file_path(errPath.get_path());
	}
	this._proc = new GSystem.Subprocess({ context: context });
	this._proc.init(cancellable);

	this._proc.wait(cancellable, Lang.bind(this, this._onChildExited));
    },

    _updateIndex: function(cancellable) {
	let allVersions = this._loadAllVersions(cancellable);

	let fileList = [];
	for (let i = 0; i < allVersions.length; i++) {
	    let [successful, version] = allVersions[i];
	    let fname = (successful ? 'successful/' : 'failed/') + version;
	    fileList.push(fname);
	}

	let index = { files: fileList };
	JsonUtil.writeJsonFileAtomic(this.dir.get_child('index.json'), index, cancellable);
    },
    
    _onChildExited: function(proc, result) {
	let cancellable = this._cancellable;
	let [success, errmsg] = ProcUtil.asyncWaitCheckFinish(proc, result);
	let target;

        this.changed = true;
        let modifiedPath = this._taskCwd.get_child('modified.json');
        if (modifiedPath.query_exists(null)) {
            let data = JsonUtil.loadJson(modifiedPath, null);
            this.changed = data['modified'];
        }

	if (!success) {
	    target = this._failedDir.path.get_child(this._version);
	    GSystem.file_rename(this._taskCwd, target, null);
	    this._taskCwd = target;
	    this._failedDir.cleanOldVersions(this.taskData.taskDef.RetainFailed, null);
	    this.onComplete(success, errmsg);
	} else {
	    target = this._successDir.path.get_child(this._version);
	    GSystem.file_rename(this._taskCwd, target, null);
	    this._taskCwd = target;
	    this._successDir.cleanOldVersions(this.taskData.taskDef.RetainSuccess, null);
	    this.onComplete(success, null);
	}

	let elapsedMillis = GLib.get_monotonic_time() / 1000 - this._startTimeMillis;
	let targetPath = this.workdir.get_relative_path(this._taskCwd);
	let meta = { taskMetaVersion: 0,
		     taskVersion: this._version,
		     success: success,
		     errmsg: errmsg,
		     elapsedMillis: elapsedMillis,
		     path: targetPath };
	let statusTxtPath = this._taskCwd.get_child('status.txt');
	if (statusTxtPath.query_exists(null)) {
	    let contents = GSystem.file_load_contents_utf8(statusTxtPath, cancellable);
	    meta['status'] = contents.replace(/[ \n]+$/, '');
	}

	JsonUtil.writeJsonFileAtomic(this._taskCwd.get_child('meta.json'), meta, cancellable);

	// Also remove any old interrupted versions
	this._topDir.cleanOldVersions(0, null);

	this._updateIndex(cancellable);

	BuildUtil.atomicSymlinkSwap(this.dir.get_child('current'), target, cancellable);
    }
});
