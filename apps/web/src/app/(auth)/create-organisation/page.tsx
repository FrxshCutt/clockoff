import type { Metadata } from "next";
import { CreateOrganisationForm } from "@/components/auth/create-organisation-form";

export const metadata: Metadata = { title: "Set up your organisation" };

export default function CreateOrganisationPage() {
  return <CreateOrganisationForm />;
}
