/**
 * MachineClass detail/edit view -- thin wrapper around the generic
 * ResourceDetail<TSpec> (see ResourceDetail.tsx). One genuine behavioral
 * difference from ConfigPatch: the editable content is the whole spec as
 * pretty-printed JSON (`{"match_labels": [...]}`), not a single freeform
 * string field -- MachineClass's real spec is structured data (verified
 * 2026-08-12, see MachineClassesList.tsx), so editing/apply needs a
 * JSON.parse round-trip with validation, unlike ConfigPatch's always-valid
 * plain-string spec.data.
 */
import { ResourceDetail } from './ResourceDetail';

interface MachineClassSpec {
  match_labels?: string[];
  /**
   * VERIFIED against real production data (2026-08-12, omni.ad.bonkie.net's
   * `proxmox-xl` MachineClass) -- previously flagged as unconfirmed ("not
   * yet observed on the wire, do not guess its name") since no MachineClass
   * with autoprovisioning set was available to inspect at the time
   * MachineClassesList.tsx was written. Real shape, snake_case like
   * match_labels: `provider_data` is itself a string containing embedded
   * newline-escaped pseudo-YAML (e.g.
   * `"cores: 8\nsockets: 2\nmemory: 49152\n..."`), not nested JSON -- shown
   * and edited here as an opaque string, matching what's actually on the
   * wire, rather than attempting to parse/re-serialize its contents.
   */
  auto_provision?: {
    provider_id?: string;
    provider_data?: string;
  };
}

function specToText(spec: MachineClassSpec): string {
  return JSON.stringify(spec, null, 2);
}

export function MachineClassDetail() {
  return (
    <ResourceDetail<MachineClassSpec>
      resourceType="MachineClasses.omni.sidero.dev"
      listPath="/omni/machine-classes"
      listLabel="Machine Classes"
      resourceNoun="machine class"
      language="json"
      specToText={specToText}
      parseEdit={text => {
        try {
          return { spec: JSON.parse(text) };
        } catch (err) {
          return { error: `Not valid JSON — ${err instanceof Error ? err.message : String(err)}` };
        }
      }}
    />
  );
}
