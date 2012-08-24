# Copyright (C) 2011 Colin Walters <walters@verbum.org>
#
# This library is free software; you can redistribute it and/or
# modify it under the terms of the GNU Lesser General Public
# License as published by the Free Software Foundation; either
# version 2 of the License, or (at your option) any later version.
#
# This library is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
# Lesser General Public License for more details.
#
# You should have received a copy of the GNU Lesser General Public
# License along with this library; if not, write to the
# Free Software Foundation, Inc., 59 Temple Place - Suite 330,
# Boston, MA 02111-1307, USA.

import os,sys,subprocess,tempfile,re,shutil
import argparse
import time
import urlparse
import hashlib
import json
from StringIO import StringIO

from . import builtins
from .ostbuildlog import log, fatal
from .subprocess_helpers import run_sync, run_sync_get_output
from .subprocess_helpers import run_sync_monitor_log_file
from . import ostbuildrc
from . import buildutil
from . import fileutil
from . import kvfile
from . import odict
from . import vcs

class BuildOptions(object):
    pass

class OstbuildBuild(builtins.Builtin):
    name = "build"
    short_description = "Build multiple components and generate trees"

    def __init__(self):
        builtins.Builtin.__init__(self)

    def _get_ostbuild_chroot_args(self, architecture, component, component_resultdir):
        basename = component['name']
        current_machine = os.uname()[4]
        if current_machine != architecture:
            args = ['setarch', architecture]
        else:
            args = []
        args.extend(['ostbuild', 'chroot-compile-one',
                     '--snapshot=' + self.snapshot_path,
                     '--name=' + basename, '--arch=' + architecture,
                     '--resultdir=' + component_resultdir])
        return args

    def _launch_debug_shell(self, architecture, component, component_resultdir, cwd=None):
        args = self._get_ostbuild_chroot_args(architecture, component, component_resultdir)
        args.append('--debug-shell')
        run_sync(args, cwd=cwd, fatal_on_error=False, keep_stdin=True)
        fatal("Exiting after debug shell")

    def _analyze_build_failure(self, architecture, component, component_srcdir,
                               current_vcs_version, previous_vcs_version):
        if (current_vcs_version is not None and previous_vcs_version is not None):
            git_args = ['git', 'log', '--format=short']
            git_args.append(previous_vcs_version + '...' + current_vcs_version)
            subproc_env = dict(os.environ)
            subproc_env['GIT_PAGER'] = 'cat'
            run_sync(git_args, cwd=component_srcdir, stdin=open('/dev/null'),
                     stdout=sys.stdout, env=subproc_env, log_success=False)
        else:
            log("No previous build; skipping source diff")

    def _needs_rebuild(self, previous_metadata, new_metadata):
        build_keys = ['config-opts', 'src', 'revision']
        for k in build_keys:
            if (k not in new_metadata) or (previous_metadata[k] != new_metadata[k]):
                return 'key %r differs' % (k, )
            
        if 'patches' in previous_metadata:
            if 'patches' not in new_metadata:
                return 'patches differ'
            old_patches = previous_metadata['patches']
            new_patches = new_metadata['patches']
            old_files = old_patches['files']
            new_files = new_patches['files']
            if len(old_files) != len(new_files):
                return 'patches differ'
            old_sha256sums = old_patches.get('files_sha256sums')
            new_sha256sums = new_patches.get('files_sha256sums')
            if ((old_sha256sums is None or new_sha256sums is None) or
                len(old_sha256sums) != len(new_sha256sums) or
                old_sha256sums != new_sha256sums):
                return 'patch sha256sums differ'
        return None

    def _compute_sha256sums_for_patches(self, patchdir, component):
        patches = buildutil.get_patch_paths_for_component(patchdir, component)
        result = []

        for patch in patches:
            csum = hashlib.sha256()
            f = open(patch)
            patchdata = f.read()
            csum.update(patchdata)
            f.close()
            result.append(csum.hexdigest())
        return result

    def _build_one_component(self, component, architecture):
        basename = component['name']

        buildname = '%s/%s/%s' % (self.snapshot['prefix'], basename, architecture)
        build_ref = 'components/%s' % (buildname, )

        current_vcs_version = component.get('revision')

        expanded_component = self.expand_component(component)

        skip_rebuild = self.args.compose_only
        
        if not skip_rebuild:
            if 'patches' in expanded_component:
                patchdir = vcs.checkout_patches(self.mirrordir,
                                                self.patchdir,
                                                expanded_component,
                                                patches_path=self.args.patches_path)
                patches_sha256sums = self._compute_sha256sums_for_patches(patchdir, expanded_component)
                expanded_component['patches']['files_sha256sums'] = patches_sha256sums
            else:
                patchdir = None

            force_rebuild = (self.buildopts.force_rebuild or
                             basename in self.force_build_components)
        else:
            force_rebuild = False

        previous_build_version = run_sync_get_output(['ostree', '--repo=' + self.repo,
                                                      'rev-parse', build_ref],
                                                     stderr=open('/dev/null', 'w'),
                                                     none_on_error=True)
        previous_vcs_version = None
        previous_metadata = None

        if previous_build_version is not None:
            previous_metadata_text = run_sync_get_output(['ostree', '--repo=' + self.repo,
                                                          'cat', previous_build_version,
                                                          '/_ostbuild-meta.json'])
            sha = hashlib.sha256()
            sha.update(previous_metadata_text)

            previous_metadata = json.loads(previous_metadata_text)
            previous_vcs_version = previous_metadata.get('revision')

            log("Previous build of %s is ostree:%s " % (buildname, previous_build_version))

            if skip_rebuild:
                return previous_build_version

            rebuild_reason = self._needs_rebuild(previous_metadata, expanded_component)
            if rebuild_reason is None:
                if not force_rebuild:
                    log("Reusing cached build at %s" % (previous_vcs_version)) 
                    return previous_build_version
                else:
                    log("Build forced regardless") 
            else:
                    log("Need rebuild of %s: %s" % (buildname, rebuild_reason, ) )
        else:
            log("No previous build for '%s' found" % (buildname, ))
            if skip_rebuild:
                fatal("--compose-only specified but no previous build found")

        (fd, temp_metadata_path) = tempfile.mkstemp(suffix='.json', prefix='ostbuild-metadata-')
        os.close(fd)
        f = open(temp_metadata_path, 'w')
        json.dump(expanded_component, f, indent=4, sort_keys=True)
        f.close()

        checkoutdir = os.path.join(self.workdir, 'checkouts')
        component_src = os.path.join(checkoutdir, buildname)
        fileutil.ensure_parent_dir(component_src)
        child_args = ['ostbuild', 'checkout', '--snapshot=' + self.snapshot_path,
                      '--checkoutdir=' + component_src,
                      '--metadata-path=' + temp_metadata_path,
                      '--clean', '--overwrite', basename]
        if self.args.patches_path:
            child_args.append('--patches-path=' + self.args.patches_path)
        elif patchdir is not None:
            child_args.append('--patches-path=' + patchdir)
        run_sync(child_args)

        os.unlink(temp_metadata_path)

        artifact_meta = dict(component)

        logdir = os.path.join(self.workdir, 'logs', buildname)
        fileutil.ensure_dir(logdir)
        log_path = os.path.join(logdir, 'compile.log')
        if os.path.isfile(log_path):
            curtime = int(time.time())
            saved_name = os.path.join(logdir, 'compile-prev.log')
            os.rename(log_path, saved_name)

        component_resultdir = os.path.join(self.workdir, 'results', buildname)
        if os.path.isdir(component_resultdir):
            shutil.rmtree(component_resultdir)
        fileutil.ensure_dir(component_resultdir)

        self._write_status({'status': 'building',
                            'target': build_ref})

        log("Logging to %s" % (log_path, ))
        f = open(log_path, 'w')
        chroot_args = self._get_ostbuild_chroot_args(architecture, component, component_resultdir)
        success = run_sync_monitor_log_file(chroot_args, log_path, cwd=component_src, fatal_on_error=False)
        if not success:
            if self.buildopts.shell_on_failure:
                self._launch_debug_shell(architecture, component, component_resultdir, cwd=component_src)
            self._analyze_build_failure(architecture, component, component_src,
                                        current_vcs_version, previous_vcs_version)
            self._write_status({'status': 'failed',
                                'target': build_ref})
            fatal("Exiting due to build failure in component:%s arch:%s" % (component, architecture))

        args = ['ostree', '--repo=' + self.repo,
                'commit', '-b', build_ref, '-s', 'Build',
                '--owner-uid=0', '--owner-gid=0', '--no-xattrs', 
                '--skip-if-unchanged']

        setuid_files = artifact_meta.get('setuid', [])
        statoverride_path = None
        if len(setuid_files) > 0:
            (fd, statoverride_path) = tempfile.mkstemp(suffix='.txt', prefix='ostbuild-statoverride-')
            f = os.fdopen(fd, 'w')
            for path in setuid_files:
                f.write('+2048 ' + path)
                f.write('\n')
            f.close()
            args.append('--statoverride=' + statoverride_path)

        run_sync(args, cwd=component_resultdir)
        if statoverride_path is not None:
            os.unlink(statoverride_path)

        if os.path.islink(component_src):
            os.unlink(component_src)
        else:
            shutil.rmtree(component_src)
        shutil.rmtree(component_resultdir)

        return run_sync_get_output(['ostree', '--repo=' + self.repo,
                                    'rev-parse', build_ref])

    def _compose_one_target(self, target, component_build_revs):
        base = target['base']
        base_name = 'bases/%s' % (base['name'], )
        runtime_name = 'bases/%s' % (base['runtime'], )
        devel_name = 'bases/%s' % (base['devel'], )

        compose_rootdir = os.path.join(self.workdir, 'roots', target['name'])
        fileutil.ensure_parent_dir(compose_rootdir)
        if os.path.isdir(compose_rootdir):
            shutil.rmtree(compose_rootdir)
        os.mkdir(compose_rootdir)

        related_refs = {}

        base_revision = run_sync_get_output(['ostree', '--repo=' + self.repo,
                                             'rev-parse', base_name])

        runtime_revision = run_sync_get_output(['ostree', '--repo=' + self.repo,
                                                'rev-parse', runtime_name])
        related_refs[runtime_name] = runtime_revision
        devel_revision = run_sync_get_output(['ostree', '--repo=' + self.repo,
                                              'rev-parse', devel_name])
        related_refs[devel_name] = devel_revision

        for name,rev in component_build_revs.iteritems():
            build_ref = 'components/%s/%s' % (self.snapshot['prefix'], name)
            related_refs[build_ref] = rev

        (related_fd, related_tmppath) = tempfile.mkstemp(suffix='.txt', prefix='ostbuild-compose-')
        related_f = os.fdopen(related_fd, 'w')
        for (name, rev) in related_refs.iteritems():
            related_f.write(name) 
            related_f.write(' ') 
            related_f.write(rev) 
            related_f.write('\n') 
        related_f.close()

        compose_contents = [(base_revision, '/')]
        for tree_content in target['contents']:
            name = tree_content['name']
            rev = component_build_revs[name]
            subtrees = tree_content['trees']
            for subpath in subtrees:
                compose_contents.append((rev, subpath))

        (contents_fd, contents_tmppath) = tempfile.mkstemp(suffix='.txt', prefix='ostbuild-compose-')
        contents_f = os.fdopen(contents_fd, 'w')
        for (branch, subpath) in compose_contents:
            contents_f.write(branch)
            contents_f.write('\0')
            contents_f.write(subpath)
            contents_f.write('\0')
        contents_f.close()

        run_sync(['ostree', '--repo=' + self.repo,
                  'checkout', '--user-mode', '--no-triggers', '--union', 
                  '--from-file=' + contents_tmppath, compose_rootdir])
        os.unlink(contents_tmppath)

        contents_path = os.path.join(compose_rootdir, 'contents.json')
        f = open(contents_path, 'w')
        json.dump(self.snapshot, f, indent=4, sort_keys=True)
        f.close()

        treename = 'trees/%s' % (target['name'], )
        
        child_args = ['ostree', '--repo=' + self.repo,
                      'commit', '-b', treename, '-s', 'Compose',
                      '--owner-uid=0', '--owner-gid=0', '--no-xattrs', 
                      '--related-objects-file=' + related_tmppath,
                      ]
        if not self.buildopts.no_skip_if_unchanged:
            child_args.append('--skip-if-unchanged')
        run_sync(child_args, cwd=compose_rootdir)
        os.unlink(related_tmppath)
        shutil.rmtree(compose_rootdir)

    def _write_status(self, data):
        if not self.args.status_json_path:
            return
        (fd, temppath) = tempfile.mkstemp(suffix='.tmp', prefix='status-json-',
                                          dir=os.path.dirname(self.args.status_json_path))
        os.close(fd)
        f = open(temppath, 'w')
        json.dump(data, f, indent=4, sort_keys=True)
        f.close()
        os.rename(temppath, self.args.status_json_path)

    def execute(self, argv):
        parser = argparse.ArgumentParser(description=self.short_description)
        parser.add_argument('--prefix')
        parser.add_argument('--src-snapshot')
        parser.add_argument('--patches-path')
        parser.add_argument('--status-json-path',
                            help="Write data to this JSON file as build progresses")
        parser.add_argument('--force-rebuild', action='store_true')
        parser.add_argument('--skip-vcs-matches', action='store_true')
        parser.add_argument('--no-compose', action='store_true')
        parser.add_argument('--no-skip-if-unchanged', action='store_true')
        parser.add_argument('--compose-only', action='store_true')
        parser.add_argument('--shell-on-failure', action='store_true')
        parser.add_argument('components', nargs='*')
        
        args = parser.parse_args(argv)
        self.args = args
        
        self.parse_config()
        self.parse_snapshot(args.prefix, args.src_snapshot)

        log("Using source snapshot: %s" % (os.path.basename(self.snapshot_path), ))

        self._write_status({'state': 'build-starting'})

        self.buildopts = BuildOptions()
        self.buildopts.shell_on_failure = args.shell_on_failure
        self.buildopts.force_rebuild = args.force_rebuild
        self.buildopts.skip_vcs_matches = args.skip_vcs_matches
        self.buildopts.no_skip_if_unchanged = args.no_skip_if_unchanged

        self.force_build_components = set()

        components = self.snapshot['components']

        prefix = self.snapshot['prefix']
        base_prefix = '%s/%s' % (self.snapshot['base']['name'], prefix)

        architectures = self.snapshot['architectures']

        component_to_arches = {}

        runtime_components = []
        devel_components = []

        for component in components:
            name = component['name']

            is_runtime = component.get('component', 'runtime') == 'runtime'

            if is_runtime:
                runtime_components.append(component)
            devel_components.append(component)

            is_noarch = component.get('noarch', False)
            if is_noarch:
                # Just use the first specified architecture
                component_arches = [architectures[0]]
            else:
                component_arches = component.get('architectures', architectures)
            component_to_arches[name] = component_arches

        for name in args.components:
            component = self.get_component(name)
            self.force_build_components.add(component['name'])

        components_to_build = []
        component_skipped_count = 0

        component_build_revs = {}

        for component in components:
            for architecture in architectures:
                components_to_build.append((component, architecture))

        log("%d components to build" % (len(components_to_build), ))
        for (component, architecture) in components_to_build:
            archname = '%s/%s' % (component['name'], architecture)
            build_rev = self._build_one_component(component, architecture)
            self._write_status({'status': 'scanning'})
            component_build_revs[archname] = build_rev

        targets_list = []
        for target_component_type in ['runtime', 'devel']:
            for architecture in architectures:
                target = {}
                targets_list.append(target)
                target['name'] = '%s-%s-%s' % (prefix, architecture, target_component_type)

                runtime_ref = '%s-%s-runtime' % (base_prefix, architecture)
                buildroot_ref = '%s-%s-devel' % (base_prefix, architecture)
                if target_component_type == 'runtime':
                    base_ref = runtime_ref
                else:
                    base_ref = buildroot_ref
                target['base'] = {'name': base_ref,
                                  'runtime': runtime_ref,
                                  'devel': buildroot_ref}

                self._write_status({'status': 'composing',
                                    'target': target['name']})

                if target_component_type == 'runtime':
                    target_components = runtime_components
                else:
                    target_components = devel_components
                    
                contents = []
                for component in target_components:
                    if component.get('bootstrap'):
                        log("Skipping bootstrap component %r" % (component['name'], ))
                        continue
                    builds_for_component = component_to_arches[component['name']]
                    if architecture not in builds_for_component:
                        continue
                    binary_name = '%s/%s' % (component['name'], architecture)
                    component_ref = {'name': binary_name}
                    if target_component_type == 'runtime':
                        component_ref['trees'] = ['/runtime']
                    else:
                        component_ref['trees'] = ['/runtime', '/devel', '/doc']
                    contents.append(component_ref)
                target['contents'] = contents

        for target in targets_list:
            self._compose_one_target(target, component_build_revs)

        self._write_status({'status': 'complete'})

builtins.register(OstbuildBuild)
