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
import { ClusterCreate } from './omni/ClusterCreate';
import { ClusterDetail } from './omni/ClusterDetail';
import { ClustersList } from './omni/ClustersList';
import { ConfigPatchDetail } from './omni/ConfigPatchDetail';
import { ConfigPatchesList } from './omni/ConfigPatchesList';
import { MachineClassDetail } from './omni/MachineClassDetail';
import { MachineClassesList } from './omni/MachineClassesList';
import { SessionExpiryWarning } from './omni/SessionExpiryWarning';
import { OmniSettingsComponent } from './omni/settings';

// Top-level "Omni" sidebar section, no cluster context — Omni is a fleet-level
// control plane above any single cluster (see design doc Problem Statement).
//
// Needs an explicit `url` even though it's just a category header: without
// one, clicking it falls back to Headlamp's SidebarItem.getFullURLOnRoute(),
// which resolves the first child by matching the child SIDEBAR entry's
// `name` ('omni-config-patches') against a registered ROUTE's `name` --  a
// different string here ('Omni Config Patches', below) since sidebar-entry
// names and route names are separate, unrelated fields in Headlamp's API.
// That lookup silently fails and falls through to home ('#/') with no
// error -- confirmed by reproducing the click and inspecting the rendered
// <a href> directly. An explicit `url` here is used as-is, bypassing that
// lookup entirely.
//
// Points at /omni/clusters now, not /omni/config-patches: Clusters is the
// root of the resource graph (a ConfigPatch/MachineClass is a detail of, or
// input to, a cluster -- see cluster.ts), so it's the more useful landing
// page now that cluster lifecycle management exists.
registerSidebarEntry({
  parent: null,
  name: 'omni',
  label: 'Omni',
  icon: 'mdi:server-network',
  url: '/omni/clusters',
  useClusterURL: false,
});

registerSidebarEntry({
  parent: 'omni',
  name: 'omni-clusters',
  label: 'Clusters',
  url: '/omni/clusters',
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

registerRoute({
  path: '/omni/clusters',
  sidebar: 'omni-clusters',
  name: 'Omni Clusters',
  useClusterURL: false,
  // See the identical note on the ConfigPatches list route below -- same
  // react-router v5 Switch prefix-matching collision, this time with BOTH
  // /omni/clusters/new and /omni/clusters/:id.
  exact: true,
  noAuthRequired: true,
  component: () => (
    <SectionBox title="Clusters">
      <ClustersList />
    </SectionBox>
  ),
});

// Registered before the /omni/clusters/:id route below: react-router v5's
// Switch is first-match-wins, and :id would otherwise match "new" as an id
// (same segment count, no exact requirement needed for a match) and render
// the detail view for a cluster literally named "new" instead of the create
// form.
registerRoute({
  path: '/omni/clusters/new',
  sidebar: 'omni-clusters',
  name: 'Omni Cluster Create',
  useClusterURL: false,
  exact: true,
  noAuthRequired: true,
  component: () => (
    <SectionBox title="Create Cluster">
      <ClusterCreate />
    </SectionBox>
  ),
});

registerRoute({
  path: '/omni/clusters/:id',
  sidebar: 'omni-clusters',
  name: 'Omni Cluster Detail',
  useClusterURL: false,
  noAuthRequired: true,
  component: () => (
    <SectionBox title="Cluster">
      <ClusterDetail />
    </SectionBox>
  ),
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
      <SessionExpiryWarning />
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
      <SessionExpiryWarning />
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
      <SessionExpiryWarning />
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
      <SessionExpiryWarning />
    </SectionBox>
  ),
});

registerPluginSettings('omni-manager', OmniSettingsComponent, true);
