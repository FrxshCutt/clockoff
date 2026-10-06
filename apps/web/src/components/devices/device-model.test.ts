import { describe, expect, it } from "vitest";
import {
  DEFAULT_DEVICE_LIST_PARAMS,
  describeAppVersion,
  describeClockSkew,
  describeOs,
  describePolicyVersion,
  describeSelectionCounts,
  deviceDisplayName,
  hasActiveDeviceFilters,
  parseDeviceListParams,
  parsePermissionList,
  serializeDeviceListParams,
  toDeviceApiQuery,
  type DeviceListParams,
} from "./device-model";

const EMPLOYEE_ID = "0b0e2e9e-7c0a-4a2b-9e3b-1b4c2a9d8f10";
const LOCATION_ID = "c7a1c8f2-4d7e-4d1b-9e55-2a4d8b6c3e21";

const parse = (qs: string) => parseDeviceListParams(new URLSearchParams(qs));

describe("device list URL state", () => {
  it("defaults to active devices and a clean URL", () => {
    expect(parse("")).toEqual(DEFAULT_DEVICE_LIST_PARAMS);
    expect(serializeDeviceListParams(DEFAULT_DEVICE_LIST_PARAMS)).toBe("");
  });

  it("round-trips every filter", () => {
    const state: DeviceListParams = {
      active: "all",
      permission: ["DENIED", "REVOKED"],
      employeeId: EMPLOYEE_ID,
      locationId: LOCATION_ID,
      page: 2,
      pageSize: 50,
    };
    const qs = serializeDeviceListParams(state);
    expect(qs).toContain("active=all");
    expect(qs).toContain("permission=DENIED%2CREVOKED");
    expect(parse(qs)).toEqual(state);
  });

  it("falls back for invalid values", () => {
    const state = parse(
      "active=bogus&permission=BOGUS,DENIED&employee=nope&location=1&page=-1&pageSize=7",
    );
    expect(state).toEqual({ ...DEFAULT_DEVICE_LIST_PARAMS, permission: ["DENIED"] });
    expect(parsePermissionList(["DENIED", "denied", "DENIED,APPROVED"])).toEqual([
      "DENIED",
      "APPROVED",
    ]);
  });

  it("maps to GET /api/devices parameters", () => {
    expect(toDeviceApiQuery(DEFAULT_DEVICE_LIST_PARAMS)).toEqual({
      page: 1,
      pageSize: 25,
      isActive: true,
    });
    expect(toDeviceApiQuery({ ...DEFAULT_DEVICE_LIST_PARAMS, active: "inactive" })).toEqual({
      page: 1,
      pageSize: 25,
      isActive: false,
    });
    expect(
      toDeviceApiQuery({
        ...DEFAULT_DEVICE_LIST_PARAMS,
        active: "all",
        permission: ["DENIED"],
        employeeId: EMPLOYEE_ID,
        locationId: LOCATION_ID,
      }),
    ).toEqual({
      page: 1,
      pageSize: 25,
      permissionState: ["DENIED"],
      employeeId: EMPLOYEE_ID,
      locationId: LOCATION_ID,
    });
  });

  it("knows when filters are active (paging alone is not a filter)", () => {
    expect(hasActiveDeviceFilters(DEFAULT_DEVICE_LIST_PARAMS)).toBe(false);
    expect(hasActiveDeviceFilters({ ...DEFAULT_DEVICE_LIST_PARAMS, page: 3, pageSize: 50 })).toBe(
      false,
    );
    expect(hasActiveDeviceFilters({ ...DEFAULT_DEVICE_LIST_PARAMS, active: "all" })).toBe(true);
    expect(
      hasActiveDeviceFilters({ ...DEFAULT_DEVICE_LIST_PARAMS, permission: ["APPROVED"] }),
    ).toBe(true);
  });
});

describe("descriptions (§12 operational fields only)", () => {
  it("describes selection counts without naming anything", () => {
    expect(describeSelectionCounts({ categories: 0, applications: 0, webDomains: 0 })).toBe(
      "Nothing selected",
    );
    expect(describeSelectionCounts({ categories: 1, applications: 12, webDomains: 2 })).toBe(
      "1 category · 12 apps · 2 websites",
    );
    expect(describeSelectionCounts({ categories: 3, applications: 0, webDomains: 1 })).toBe(
      "3 categories · 1 website",
    );
  });

  it("formats OS and app versions", () => {
    expect(describeOs({ platform: "IOS", osVersion: "18.1" })).toBe("iOS 18.1");
    expect(describeOs({ platform: "IOS", osVersion: null })).toBe("—");
    expect(describeAppVersion({ appVersion: "1.4.2" })).toBe("v1.4.2");
    expect(describeAppVersion({ appVersion: null })).toBe("—");
  });

  it("names the device after its owner", () => {
    expect(
      deviceDisplayName({ deviceModel: "iPhone 15" }, { firstName: "Jane", lastName: "Smith" }),
    ).toBe("Jane Smith's iPhone 15");
    expect(deviceDisplayName({ deviceModel: null }, { firstName: "Chris", lastName: "Ross" })).toBe(
      "Chris Ross' iPhone",
    );
    expect(deviceDisplayName({ deviceModel: " iPhone SE " }, { firstName: "", lastName: "" })).toBe(
      "iPhone SE",
    );
  });

  it("describes clock skew in minutes with direction", () => {
    expect(describeClockSkew(null)).toBeNull();
    expect(describeClockSkew(30)).toBe("In sync");
    expect(describeClockSkew(-59)).toBe("In sync");
    expect(describeClockSkew(180)).toBe("3 min ahead");
    expect(describeClockSkew(-420)).toBe("7 min behind");
    expect(describeClockSkew(Number.NaN)).toBeNull();
  });

  it("describes the synced policy version", () => {
    expect(describePolicyVersion({ policyVersionId: "v", policyVersionNumber: 3 })).toBe(
      "Version 3",
    );
    expect(describePolicyVersion({ policyVersionId: "v", policyVersionNumber: null })).toBe(
      "Synced",
    );
    expect(describePolicyVersion({ policyVersionId: null, policyVersionNumber: null })).toBe(
      "Not synced yet",
    );
  });
});
