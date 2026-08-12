/**
 * ConfigPatch detail/edit view -- thin wrapper around the generic
 * ResourceDetail<TSpec> (see ResourceDetail.tsx), supplying ConfigPatch's
 * identity/copy and its one genuine behavioral difference from
 * MachineClass: editing a single freeform string field (spec.data), always
 * valid, merged back into the existing spec on apply so unrelated fields
 * (e.g. compresseddata) round-trip unchanged.
 */
import { ResourceDetail } from './ResourceDetail';

interface ConfigPatchSpec {
  data?: string;
  compresseddata?: string;
}

export function ConfigPatchDetail() {
  return (
    <ResourceDetail<ConfigPatchSpec>
      resourceType="ConfigPatches.omni.sidero.dev"
      listPath="/omni/config-patches"
      listLabel="Config Patches"
      resourceNoun="patch"
      language="yaml"
      specToText={spec => spec.data ?? ''}
      parseEdit={(text, currentSpec) => ({ spec: { ...currentSpec, data: text } })}
    />
  );
}
