/*
 * Copyright 2025 The Kubernetes Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { registerPluginSettings, registerRoute, registerSidebarEntry } from '@kinvolk/headlamp-plugin/lib';
import { SectionBox } from '@kinvolk/headlamp-plugin/lib/CommonComponents';
import { ConfigPatchDetail } from './omni/ConfigPatchDetail';
import { ConfigPatchesList } from './omni/ConfigPatchesList';
import { MachineClassDetail } from './omni/MachineClassDetail';
import { MachineClassesList } from './omni/MachineClassesList';
import { OmniSettingsComponent } from './omni/settings';

// Top-level "Omni" sidebar section, no cluster context — Omni is a fleet-level
// control plane above any single cluster (see design doc Problem Statement).
registerSidebarEntry({
  parent: null,
  name: 'omni',
  label: 'Omni',
  icon: 'mdi:server-network',
  useClusterURL: false,
});

registerSidebarEntry({
  parent: 'omni',
  name: 'omni-config-patches',
  label: 'Config Patches',
  url: '/omni/config-patches',
  useClusterURL: false,
});

registerSidebarEntry({
  parent: 'omni',
  name: 'omni-machine-classes',
  label: 'Machine Classes',
  url: '/omni/machine-classes',
  useClusterURL: false,
});

// PR1 scope: read-only. Edit/diff/apply/delete land in PR2 per the design doc's
// delivery-shape decision.
registerRoute({
  path: '/omni/config-patches',
  sidebar: 'omni-config-patches',
  name: 'Omni Config Patches',
  useClusterURL: false,
  // Without this, react-router v5's Switch (first-match-wins, prefix
  // matching by default) matches this route for /omni/config-patches/:id
  // too, since it's a string prefix of that path -- the detail route below
  // would then never render, with no error.
  exact: true,
  // Headlamp's AuthRoute gates non-cluster routes on a per-cluster auth
  // query that never runs (no cluster in context to test against) unless
  // this is set -- without it the route silently renders null forever, no
  // error. Omni's own auth is handled entirely by auth.ts's service-account
  // signing, not Headlamp's per-cluster token flow.
  noAuthRequired: true,
  component: () => (
    <SectionBox title="Config Patches">
      <ConfigPatchesList />
    </SectionBox>
  ),
});

// PR2 scope: edit/diff/apply/delete for a single ConfigPatch.
registerRoute({
  path: '/omni/config-patches/:id',
  sidebar: 'omni-config-patches',
  name: 'Omni Config Patch Detail',
  useClusterURL: false,
  noAuthRequired: true,
  component: () => (
    <SectionBox title="Config Patch">
      <ConfigPatchDetail />
    </SectionBox>
  ),
});

registerRoute({
  path: '/omni/machine-classes',
  sidebar: 'omni-machine-classes',
  name: 'Omni Machine Classes',
  useClusterURL: false,
  // See the identical note on the ConfigPatches list route above -- same
  // react-router v5 Switch prefix-matching collision with the detail route.
  exact: true,
  noAuthRequired: true,
  component: () => (
    <SectionBox title="Machine Classes">
      <MachineClassesList />
    </SectionBox>
  ),
});

// PR2 scope: edit/diff/apply/delete for a single MachineClass.
registerRoute({
  path: '/omni/machine-classes/:id',
  sidebar: 'omni-machine-classes',
  name: 'Omni Machine Class Detail',
  useClusterURL: false,
  noAuthRequired: true,
  component: () => (
    <SectionBox title="Machine Class">
      <MachineClassDetail />
    </SectionBox>
  ),
});

registerPluginSettings('omni-manager', OmniSettingsComponent, true);
