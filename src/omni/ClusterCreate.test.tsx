// Same auth.ts/openpgp import-time crash under jsdom as cluster.test.ts and
// client.test.ts -- mocked out for the same reason, plus ConfigStore (real
// one needs Headlamp's own Redux store, which isn't set up in this
// environment either).
import '@testing-library/jest-dom/vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./auth', () => ({
  loadServiceAccount: vi.fn(),
  signResourceServiceRequest: vi.fn(),
}));

const configGetMock = vi.fn();
vi.mock('@kinvolk/headlamp-plugin/lib', () => ({
  ApiProxy: { request: vi.fn() },
  ConfigStore: class {
    get() {
      return configGetMock();
    }
  },
}));

const listResourcesMock = vi.fn();
vi.mock('./client', async importOriginal => {
  const actual = await importOriginal<typeof import('./client')>();
  return { ...actual, listResources: (...args: unknown[]) => listResourcesMock(...args) };
});

const createClusterMock = vi.fn();
vi.mock('./cluster', async importOriginal => {
  const actual = await importOriginal<typeof import('./cluster')>();
  return { ...actual, createCluster: (...args: unknown[]) => createClusterMock(...args) };
});

import { ClusterCreate } from './ClusterCreate';

function renderCreate() {
  return render(
    <MemoryRouter>
      <ClusterCreate />
    </MemoryRouter>
  );
}

/** Picks an option from an MUI Select identified by its visible label. */
async function selectOption(
  user: ReturnType<typeof userEvent.setup>,
  label: string | RegExp,
  optionName: string
) {
  await user.click(screen.getByLabelText(label));
  const listbox = await screen.findByRole('listbox');
  await user.click(within(listbox).getByRole('option', { name: optionName }));
}

describe('ClusterCreate', () => {
  beforeEach(() => {
    configGetMock.mockReturnValue({ endpoint: 'https://omni.example.com' });
    listResourcesMock.mockImplementation((_config: unknown, type: string) => {
      if (type === 'TalosVersions.omni.sidero.dev') {
        return Promise.resolve({
          items: [
            { metadata: { id: '1.7.0' }, spec: { compatible_kubernetes_versions: ['1.30.0'] } },
          ],
          total: 1,
        });
      }
      if (type === 'MachineClasses.omni.sidero.dev') {
        return Promise.resolve({ items: [{ metadata: { id: 'beefy' }, spec: {} }], total: 1 });
      }
      return Promise.resolve({ items: [], total: 0 });
    });
    createClusterMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('submits an explicit-machine control plane with no workers', async () => {
    const user = userEvent.setup();
    renderCreate();

    await user.type(await screen.findByLabelText(/cluster name/i), 'my-cluster');
    await selectOption(user, /talos version/i, '1.7.0');
    await selectOption(user, /kubernetes version/i, '1.30.0');
    // Control plane defaults to "Machine class allocation" -- switch to explicit for this test.
    await user.click(screen.getAllByRole('radio', { name: /explicit machines/i })[0]);
    await user.type(screen.getByLabelText(/control plane machine uuids/i), 'm1\nm2\nm3');

    await user.click(screen.getByRole('button', { name: /create cluster/i }));

    await waitFor(() => expect(createClusterMock).toHaveBeenCalledTimes(1));
    const input = createClusterMock.mock.calls[0][1];
    expect(input.name).toBe('my-cluster');
    expect(input.controlPlane).toEqual({ kind: 'explicit', machineIds: ['m1', 'm2', 'm3'] });
    expect(input.worker).toBeUndefined();
  });

  it('submits a machine-class control plane allocation, mirroring worker options', async () => {
    const user = userEvent.setup();
    renderCreate();

    await user.type(await screen.findByLabelText(/cluster name/i), 'my-cluster');
    await selectOption(user, /talos version/i, '1.7.0');
    await selectOption(user, /kubernetes version/i, '1.30.0');

    // Two "Machine class allocation" radios exist (control plane + worker) --
    // the control plane's is the first one in document order.
    const machineClassRadios = screen.getAllByRole('radio', { name: /machine class allocation/i });
    await user.click(machineClassRadios[0]);
    await selectOption(user, /^machine class$/i, 'beefy');

    const countField = screen.getByLabelText(/^count$/i);
    await user.clear(countField);
    await user.type(countField, '3');

    await user.click(screen.getByRole('button', { name: /create cluster/i }));

    await waitFor(() => expect(createClusterMock).toHaveBeenCalledTimes(1));
    const input = createClusterMock.mock.calls[0][1];
    expect(input.controlPlane).toEqual({ kind: 'machineClass', name: 'beefy', count: 3 });
  });

  it('blocks submission on an even control plane count and explains why', async () => {
    const user = userEvent.setup();
    renderCreate();

    await user.type(await screen.findByLabelText(/cluster name/i), 'my-cluster');
    await selectOption(user, /talos version/i, '1.7.0');
    await selectOption(user, /kubernetes version/i, '1.30.0');
    await user.click(screen.getAllByRole('radio', { name: /explicit machines/i })[0]);
    await user.type(screen.getByLabelText(/control plane machine uuids/i), 'm1\nm2');

    expect(screen.getByText(/etcd requirement/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /create cluster/i })).toBeDisabled();
    expect(createClusterMock).not.toHaveBeenCalled();
  });

  it('submits with workers set to a machine-class allocation alongside the control plane', async () => {
    const user = userEvent.setup();
    renderCreate();

    await user.type(await screen.findByLabelText(/cluster name/i), 'my-cluster');
    await selectOption(user, /talos version/i, '1.7.0');
    await selectOption(user, /kubernetes version/i, '1.30.0');
    // Control plane defaults to "Machine class allocation" -- switch to explicit for this test.
    await user.click(screen.getAllByRole('radio', { name: /explicit machines/i })[0]);
    await user.type(screen.getByLabelText(/control plane machine uuids/i), 'm1\nm2\nm3');

    // Two "Machine class allocation" radios exist (control plane + worker) --
    // the worker section's is the second one in document order.
    const machineClassRadios = screen.getAllByRole('radio', { name: /machine class allocation/i });
    await user.click(machineClassRadios[1]);
    await selectOption(user, /^machine class$/i, 'beefy');
    await user.click(screen.getByLabelText(/unlimited/i));

    await user.click(screen.getByRole('button', { name: /create cluster/i }));

    await waitFor(() => expect(createClusterMock).toHaveBeenCalledTimes(1));
    const input = createClusterMock.mock.calls[0][1];
    expect(input.worker).toEqual({ kind: 'machineClass', name: 'beefy', count: 'unlimited' });
  });
});
