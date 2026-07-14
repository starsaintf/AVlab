import {describe, expect, it} from "vitest";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import projectSchema from "../schemas/project.schema.json" with {type: "json"};
import packageSchema from "../schemas/package.schema.json" with {type: "json"};
import versionSchema from "../schemas/version.schema.json" with {type: "json"};
import previewSchema from "../schemas/preview.schema.json" with {type: "json"};
import directionSchema from "../schemas/direction.schema.json" with {type: "json"};
import proposalSchema from "../schemas/proposal.schema.json" with {type: "json"};
import reviewSchema from "../schemas/review.schema.json" with {type: "json"};

const ajv = new Ajv2020({allErrors: true});
addFormats(ajv);

describe("public contracts", () => {
  it("accepts valid project, package and version objects", () => {
    const project = {
      schema: "avlab.project/0.1", projectId: "avp_example", name: "Example", createdAt: "2026-07-14T00:00:00.000Z",
      rootKind: "directory", includePaths: ["."], defaultDirection: "main", capabilityLevel: "U0", extensions: {}
    };
    const packageManifest = {
      schema: "avlab.package/0.1", packageId: "pkg_example", projectId: "avp_example", createdAt: "2026-07-14T00:00:00.000Z",
      entries: [], totalBytes: 0, uniqueBytesWritten: 0
    };
    const version = {
      schema: "avlab.version/0.1", versionId: "avv_example", projectId: "avp_example", parentVersionIds: [], direction: "main",
      kind: "named", message: "First", createdAt: "2026-07-14T00:00:00.000Z", createdBy: {principalId: "local-human"},
      packageId: "pkg_example", manifestPath: "manifests/packages/pkg_example.json"
    };

    const preview = {schema:"avlab.preview/0.1",previewId:"prv_example",projectId:"avp_example",versionId:"avv_example",mediaKind:"audio",mimeType:"audio/mpeg",fileName:"mix.mp3",relativePath:"previews/prv_example.mp3",source:"generated",size:100,contentId:`sha256:${"a".repeat(64)}`,createdAt:"2026-07-14T00:00:00.000Z"};
    const direction = {schema:"avlab.direction/0.1",projectId:"avp_example",name:"Radio edit",baseVersionId:"avv_example",createdAt:"2026-07-14T00:00:00.000Z",createdBy:"local-human",archived:false};
    const proposal = {schema:"avlab.proposal/0.1",proposalId:"prp_example",projectId:"avp_example",versionId:"avv_example",title:"Review edit",status:"draft",createdAt:"2026-07-14T00:00:00.000Z",createdBy:"local-human"};
    const review = {schema:"avlab.review/0.1",reviewId:"rev_example",projectId:"avp_example",versionId:"avv_example",title:"Review edit",token:"secret",permissions:["view","comment","approve"],requiredApprovals:1,status:"open",createdAt:"2026-07-14T00:00:00.000Z"};
    expect(ajv.validate(projectSchema, project), JSON.stringify(ajv.errors)).toBe(true);
    expect(ajv.validate(packageSchema, packageManifest), JSON.stringify(ajv.errors)).toBe(true);
    expect(ajv.validate(versionSchema, version), JSON.stringify(ajv.errors)).toBe(true);
    expect(ajv.validate(previewSchema, preview), JSON.stringify(ajv.errors)).toBe(true);
    expect(ajv.validate(directionSchema, direction), JSON.stringify(ajv.errors)).toBe(true);
    expect(ajv.validate(proposalSchema, proposal), JSON.stringify(ajv.errors)).toBe(true);
    expect(ajv.validate(reviewSchema, review), JSON.stringify(ajv.errors)).toBe(true);
  });

  it("rejects a project that overstates its capability", () => {
    const invalid = {
      schema: "avlab.project/0.1", projectId: "wrong", name: "", createdAt: "not-a-date",
      rootKind: "directory", includePaths: [], defaultDirection: "", capabilityLevel: "U9", extensions: {}
    };
    expect(ajv.validate(projectSchema, invalid)).toBe(false);
  });
});
