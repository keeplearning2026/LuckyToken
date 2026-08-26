# Token

Token serves Data Plane requests through three independent execution lanes. This glossary defines the shared language for following one request and investigating its outcome without merging the lanes' execution ownership.

## Request Journey

**Request Journey**:
The complete lifecycle of one admitted Data Plane request, from HTTP admission through response handoff or termination.
_Avoid_: Invocation, ledger entry, log event

**Journey Phase**:
A stable, top-level segment of a Request Journey that is meaningful across operations and lanes.
_Avoid_: Status, checkpoint, implementation function

**Lane Step**:
A request-local operation owned by the selected Data Plane Lane within a Journey Phase.
_Avoid_: Shared executor step, generic native step

**Request Identity**:
The safe correlation and session facts associated with a Request Journey. It is not authorization and never grants access to a credential.
_Avoid_: Authentication, credential identity

**Response Handoff**:
The point at which Token hands a prepared response to its HTTP transport. It does not claim that the client received or consumed the response.
_Avoid_: Client delivery, client consumption

## Data Plane Lanes

**Data Plane Lane**:
One of the three independent request execution contracts: Direct Mode, Provider Native Preservation, or Semantic Conversion.
_Avoid_: Execution mode, fallback path

**Direct Mode**:
The lane that preserves a compatible Client Wire through explicit Direct Mode model/capability recognition, a preserved caller envelope, and a fixed direct transport without entering Pi; caller credentials remain part of that wire and are authenticated only by the fixed upstream.
_Avoid_: the former local-preservation lane name, generic native passthrough

**Provider Native Preservation**:
The lane that preserves a compatible Client Wire through resolved Pi model facts, Provider credential authority, and a provider-native transport without entering Pi AI IR execution.
_Avoid_: Generic native passthrough

**Semantic Conversion**:
The lane that translates Client Wire through Pi AI IR and a Pi Provider when model-visible semantics must cross different wire contracts.
_Avoid_: Pi passthrough, protocol repair

## Semantic Projection

**Projection Candidate Fact**:
A validated Client Protocol fact carried to final target selection without claiming that Pi or the target Provider has applied it. Its presence requires an explicit projection outcome, not an unconditional payload mutation.
_Avoid_: Payload patch, mandatory override

**Projection Outcome**:
The authoritative request-local disposition of one Projection Candidate Fact: already effective, target-projected, degraded, omitted, or failed.
_Avoid_: Mutation result, warning flag

## Investigation

**Request Artifact**:
A bounded, redacted snapshot of request-local evidence at a Journey seam, with explicit completeness and truncation facts.
_Avoid_: Raw log, payload dump

**Failure Location**:
The structured coordinates of a failure: Journey Phase, Data Plane Lane, direction, Lane Step, semantic subject, and source path when known.
_Avoid_: Error message, HTTP status

**Semantic Subject**:
The model-visible family being translated at a Semantic Conversion step, such as content, tools, reasoning, usage, or stop reason.
_Avoid_: Field name, protocol DTO

**Request Incident**:
The failure investigation facts attached to a non-successful Request Journey, including its Failure Location, reason, timeline, and available Request Artifacts.
_Avoid_: Failure log, deep capture record

**Request Journey Record**:
The one authoritative persisted record of a Request Journey. A non-successful record contains a Request Incident; successful records retain only the configured successful-request evidence.
_Avoid_: Request ledger row, diagnostic file, capture row

**Runtime Event**:
An application-level lifecycle, warning, failure, or degradation fact that is not owned by an admitted Request Journey, such as startup failure or diagnostics-storage unavailability. It must not be attached to a fabricated request.
_Avoid_: Synthetic request incident, requestless request record

**Diagnostics Record**:
A record persisted by the future single diagnostics authority: either a Request Journey Record or a Runtime Event. Request-owned evidence appears only in its Request Journey Record.
_Avoid_: Universal log row, second request record
