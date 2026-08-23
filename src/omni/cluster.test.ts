// cluster.ts pulls in client.ts -> auth.ts -> openpgp, which crashes at
// import time under this project's jsdom test environment -- see the
// identical note atop client.test.ts. Mocked out for the same reason: the
// resource-graph/validation logic tested here never touches auth.ts.
import { describe, expect, it, vi } from 'vitest';

vi.mock('./auth', () => ({
  loadServiceAccount: vi.fn(),
  signResourceServiceRequest: vi.fn(),
}));
vi.mock('@kinvolk/headlamp-plugin/lib', () => ({
  ApiProxy: { request: vi.fn() },
}));

import {
  buildClusterResourceGraph,
  ClusterCreateInput,
  validateClusterCreateInput,
} from './cluster';

const baseInput: ClusterCreateInput = {
  name: 'test-cluster',
  talosVersion: '1.7.0',
  kubernetesVersion: '1.30.0',
  controlPlane: { kind: 'explicit', machineIds: ['m1', 'm2', 'm3'] },
};

describe('buildClusterResourceGraph', () => {
  it('builds MachineSetNodes for an explicit control plane', () => {
    const resources = buildClusterResourceGraph(baseInput);
    const nodes = resources.filter(r => r.type === 'MachineSetNodes.omni.sidero.dev');
    expect(nodes.map(n => n.id)).toEqual(['m1', 'm2', 'm3']);
  });

  it('builds a machine_allocation MachineSet for a machineClass control plane, with no MachineSetNodes', () => {
    const resources = buildClusterResourceGraph({
      ...baseInput,
      controlPlane: { kind: 'machineClass', name: 'beefy', count: 3 },
    });
    const machineSets = resources.filter(r => r.type === 'MachineSets.omni.sidero.dev');
    const cpSet = machineSets.find(r => r.id === 'test-cluster-control-planes');
    expect(cpSet?.spec).toMatchObject({
      machine_allocation: { name: 'beefy', machine_count: 3 },
    });
    expect(resources.filter(r => r.type === 'MachineSetNodes.omni.sidero.dev')).toEqual([]);
  });

  it('builds an unlimited allocation_type for an unlimited machineClass control plane', () => {
    const resources = buildClusterResourceGraph({
      ...baseInput,
      controlPlane: { kind: 'machineClass', name: 'beefy', count: 'unlimited' },
    });
    const cpSet = resources.find(r => r.id === 'test-cluster-control-planes');
    expect(cpSet?.spec).toMatchObject({
      machine_allocation: { name: 'beefy', allocation_type: 1 },
    });
  });
});

describe('validateClusterCreateInput', () => {
  it('rejects an even explicit control plane count (etcd requirement)', () => {
    const errors = validateClusterCreateInput(
      { ...baseInput, controlPlane: { kind: 'explicit', machineIds: ['m1', 'm2'] } },
      []
    );
    expect(errors.controlPlane).toMatch(/odd/);
  });

  it('rejects an even fixed machineClass control plane count', () => {
    const errors = validateClusterCreateInput(
      { ...baseInput, controlPlane: { kind: 'machineClass', name: 'beefy', count: 2 } },
      []
    );
    expect(errors.controlPlane).toMatch(/odd/);
  });

  it('allows an unlimited machineClass control plane count (unknowable client-side)', () => {
    const errors = validateClusterCreateInput(
      { ...baseInput, controlPlane: { kind: 'machineClass', name: 'beefy', count: 'unlimited' } },
      []
    );
    expect(errors.controlPlane).toBeUndefined();
  });

  it('requires a machine class name when using machineClass control plane allocation', () => {
    const errors = validateClusterCreateInput(
      { ...baseInput, controlPlane: { kind: 'machineClass', name: '', count: 3 } },
      []
    );
    expect(errors.controlPlane).toMatch(/machine class/i);
  });

  it('accepts an odd explicit control plane count', () => {
    const errors = validateClusterCreateInput(baseInput, []);
    expect(errors.controlPlane).toBeUndefined();
  });
});
