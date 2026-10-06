import { Building2, MapPin, UserRoundPlus, Users } from "lucide-react";
import type { EmptyStateCopy } from "@/config/emptyStates";

/**
 * Empty-state copy for the lists on Locations & Teams that have no entry in `@/config/emptyStates`. The
 * page-level copy (`locations`) comes from the config so the wording stays in one place.
 */
export const LOCATIONS_EMPTY_STATES = {
  departments: {
    icon: Building2,
    title: "No departments yet",
    description:
      "Departments group employees for reporting and filtering, such as Kitchen, Front of house or Warehouse.",
    action: { label: "Add department" },
  },
  teams: {
    icon: Users,
    title: "No teams yet",
    description:
      "Teams let you assign a Work Policy or Break Rules to a group of people at once, optionally within a location.",
    action: { label: "Add team" },
  },
  teamMembers: {
    icon: UserRoundPlus,
    title: "No members yet",
    description: "Add employees to this team so its Work Policy and Break Rules apply to them.",
  },
  locationsReadOnly: {
    icon: MapPin,
    title: "No locations yet",
    description:
      "You don't have permission to add locations. Ask an owner or admin to set up your sites.",
  },
} as const satisfies Record<string, EmptyStateCopy>;
