// Private smoke-only override. !override replaces (rather than appends to) the
// staging 8123 mapping; requires Compose >= 2.24.4. Omitted published is ephemeral.
export const ephemeralPortOverride = "services:\n  app:\n    ports: !override\n      - target: 8122\n        host_ip: 127.0.0.1\n        protocol: tcp\n";

export const portIssues = new Set([
  "port_query_failed", "container_missing_or_ambiguous", "container_identity_mismatch", "container_not_running",
  "port_metadata_malformed", "published_port_missing", "published_port_ambiguous", "unexpected_target_or_protocol",
  "host_binding_not_loopback", "host_port_invalid",
]);
export class PortDiscoveryError extends Error {
  constructor(issue, cause, evidence) {
    super("Disposable Docker port discovery failed");
    this.portIssue = issue;
    this.portEvidence = evidence;
    // Keep child-process diagnostics available to the existing allowlist. Never
    // print original messages, argv, stdout/stderr, or JSON parse exceptions.
    for (const key of ["code", "signal", "killed", "stdout", "stderr"])
      if (cause?.[key] !== undefined) this[key] = cause[key];
  }
}
export function singleContainerId(stdout) {
  const ids = typeof stdout === "string" ? stdout.trim().split(/\s+/).filter(Boolean) : [];
  if (ids.length !== 1 || !/^[a-f0-9]{64}$/.test(ids[0])) throw new PortDiscoveryError("container_missing_or_ambiguous");
  return ids[0];
}

// Request only identity, running state, and requested/live port maps. Two exact
// Compose identity labels are consumed privately, never logged as label data.
export const portInspectFormat = '{"id":{{json .Id}},"project":{{json (index .Config.Labels "com.docker.compose.project")}},"service":{{json (index .Config.Labels "com.docker.compose.service")}},"running":{{json .State.Running}},"ports":{{json .NetworkSettings.Ports}},"requestedPorts":{{json .HostConfig.PortBindings}}}';
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
export function validatedLoopbackUrl(stdout, containerId, project) {
  let metadata;
  try { metadata = JSON.parse(stdout); }
  catch { throw new PortDiscoveryError("port_metadata_malformed"); }
  if (!object(metadata)) throw new PortDiscoveryError("port_metadata_malformed");
  if (metadata.id !== containerId || metadata.service !== "app" || metadata.project !== project)
    throw new PortDiscoveryError("container_identity_mismatch");
  if (metadata.running !== true) throw new PortDiscoveryError("container_not_running");
  const ports = metadata.ports;
  const evidence = {
    requestedBindingCount: Array.isArray(metadata.requestedPorts?.["8122/tcp"]) ? metadata.requestedPorts["8122/tcp"].length : 0,
    publishedTargetCount: object(ports) ? Object.keys(ports).length : 0,
    publishedBindingCount: Array.isArray(ports?.["8122/tcp"]) ? ports["8122/tcp"].length : 0,
  };
  const fail = issue => { throw new PortDiscoveryError(issue, undefined, evidence); };
  if (ports === null || ports === undefined || object(ports) && !Object.keys(ports).length) fail("published_port_missing");
  if (!object(ports)) fail("port_metadata_malformed");
  if (Object.keys(ports).some(target => target !== "8122/tcp")) fail("unexpected_target_or_protocol");
  const bindings = ports["8122/tcp"];
  if (bindings === null || bindings === undefined || Array.isArray(bindings) && bindings.length === 0) fail("published_port_missing");
  if (!Array.isArray(bindings)) fail("port_metadata_malformed");
  if (bindings.length !== 1) fail("published_port_ambiguous");
  const binding = bindings[0];
  if (!object(binding)) fail("port_metadata_malformed");
  if (binding.HostIp !== "127.0.0.1") fail("host_binding_not_loopback");
  if (typeof binding.HostPort !== "string" || !/^[1-9]\d{0,4}$/.test(binding.HostPort) || Number(binding.HostPort) > 65535) fail("host_port_invalid");
  return `http://127.0.0.1:${Number(binding.HostPort)}`;
}

export async function discoverLoopbackUrl({ compose, execute, docker, project }) {
  let stdout;
  try { ({ stdout } = await compose("ps", "--all", "--quiet", "app")); }
  catch (error) { throw new PortDiscoveryError("port_query_failed", error); }
  const container = singleContainerId(stdout);
  try { ({ stdout } = await execute(docker, ["inspect", "--type", "container", "--format", portInspectFormat, container], { timeout: 15000, windowsHide: true })); }
  catch (error) { throw new PortDiscoveryError("port_query_failed", error); }
  return validatedLoopbackUrl(stdout, container, project);
}
