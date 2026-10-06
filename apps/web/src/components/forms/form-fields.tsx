"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Eye, EyeOff, LoaderCircle } from "lucide-react";
import { useState, type ComponentProps, type ReactNode } from "react";
import {
  useForm,
  type Control,
  type FieldPath,
  type FieldValues,
  type Resolver,
  type UseFormProps,
  type UseFormReturn,
} from "react-hook-form";
import type { z } from "zod";
import { InlineAlert } from "@/components/inline-alert";
import { Button } from "@/components/ui/button";
import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { getErrorMessage, getFieldErrors } from "@/lib/errorMessages";
import { cn } from "@/lib/utils";

/**
 * react-hook-form + Zod wrappers. Forms validate with the shared `@workmode/validation` schemas on the client
 * and map the API's `VALIDATION_ERROR` field errors back onto the same fields.
 *
 * ```tsx
 * const form = useZodForm(loginSchema, { defaultValues: { email: "", password: "" } });
 * <Form {...form}><form onSubmit={form.handleSubmit(onSubmit)}>
 *   <TextField control={form.control} name="email" label="Email" type="email" />
 * </form></Form>
 * ```
 */
export function useZodForm<TInput extends FieldValues, TOutput extends FieldValues>(
  schema: z.ZodType<TOutput, TInput>,
  options?: Omit<UseFormProps<TInput, unknown, TOutput>, "resolver">,
): UseFormReturn<TInput, unknown, TOutput> {
  return useForm<TInput, unknown, TOutput>({
    mode: "onTouched",
    ...options,
    resolver: zodResolver(schema) as Resolver<TInput, unknown, TOutput>,
  });
}

/**
 * Puts server-side field errors (`VALIDATION_ERROR` details) onto matching form fields. Returns true when at
 * least one field error was applied (so the caller can skip a generic toast).
 */
export function applyApiFieldErrors<TFieldValues extends FieldValues>(
  form: Pick<UseFormReturn<TFieldValues>, "setError" | "getValues">,
  error: unknown,
): boolean {
  const fieldErrors = getFieldErrors(error);
  const known = form.getValues();
  let applied = false;
  for (const [field, message] of Object.entries(fieldErrors)) {
    if (known && Object.prototype.hasOwnProperty.call(known, field)) {
      form.setError(
        field as FieldPath<TFieldValues>,
        { type: "server", message },
        { shouldFocus: !applied },
      );
      applied = true;
    }
  }
  return applied;
}

interface BaseFieldProps<TFieldValues extends FieldValues, TName extends FieldPath<TFieldValues>> {
  /** `form.control` from `useZodForm` (or `useForm`). Context and transformed output are irrelevant to one field. */
  control: Control<TFieldValues, unknown, unknown>;
  name: TName;
  label: ReactNode;
  description?: ReactNode;
  className?: string;
}

export interface TextFieldProps<
  TFieldValues extends FieldValues,
  TName extends FieldPath<TFieldValues>,
>
  extends
    BaseFieldProps<TFieldValues, TName>,
    Omit<
      ComponentProps<typeof Input>,
      "name" | "defaultValue" | "value" | "onChange" | "onBlur" | "className"
    > {
  /** Content rendered inside the label row on the right (e.g. "Forgot password?" link). */
  labelAside?: ReactNode;
}

export function TextField<TFieldValues extends FieldValues, TName extends FieldPath<TFieldValues>>({
  control,
  name,
  label,
  description,
  className,
  labelAside,
  ...inputProps
}: TextFieldProps<TFieldValues, TName>) {
  return (
    <FormField<TFieldValues, TName, unknown>
      control={control}
      name={name}
      render={({ field }) => (
        <FormItem className={className}>
          <div className="flex items-center justify-between gap-2">
            <FormLabel>{label}</FormLabel>
            {labelAside}
          </div>
          <FormControl>
            <Input
              {...inputProps}
              {...field}
              value={(field.value as string | number | undefined) ?? ""}
            />
          </FormControl>
          {description ? <FormDescription>{description}</FormDescription> : null}
          <FormMessage />
        </FormItem>
      )}
    />
  );
}

export function PasswordField<
  TFieldValues extends FieldValues,
  TName extends FieldPath<TFieldValues>,
>({
  control,
  name,
  label,
  description,
  className,
  labelAside,
  autoComplete = "current-password",
  ...inputProps
}: Omit<TextFieldProps<TFieldValues, TName>, "type">) {
  const [visible, setVisible] = useState(false);
  return (
    <FormField<TFieldValues, TName, unknown>
      control={control}
      name={name}
      render={({ field }) => (
        <FormItem className={className}>
          <div className="flex items-center justify-between gap-2">
            <FormLabel>{label}</FormLabel>
            {labelAside}
          </div>
          <div className="relative">
            <FormControl>
              <Input
                {...inputProps}
                {...field}
                value={(field.value as string | undefined) ?? ""}
                type={visible ? "text" : "password"}
                autoComplete={autoComplete}
                className="pr-10"
              />
            </FormControl>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground hover:text-foreground absolute top-0.5 right-0.5"
              onClick={() => setVisible((v) => !v)}
              aria-label={visible ? "Hide password" : "Show password"}
              aria-pressed={visible}
            >
              {visible ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
            </Button>
          </div>
          {description ? <FormDescription>{description}</FormDescription> : null}
          <FormMessage />
        </FormItem>
      )}
    />
  );
}

export interface TextareaFieldProps<
  TFieldValues extends FieldValues,
  TName extends FieldPath<TFieldValues>,
>
  extends
    BaseFieldProps<TFieldValues, TName>,
    Omit<
      ComponentProps<typeof Textarea>,
      "name" | "defaultValue" | "value" | "onChange" | "onBlur" | "className"
    > {}

export function TextareaField<
  TFieldValues extends FieldValues,
  TName extends FieldPath<TFieldValues>,
>({
  control,
  name,
  label,
  description,
  className,
  ...textareaProps
}: TextareaFieldProps<TFieldValues, TName>) {
  return (
    <FormField<TFieldValues, TName, unknown>
      control={control}
      name={name}
      render={({ field }) => (
        <FormItem className={className}>
          <FormLabel>{label}</FormLabel>
          <FormControl>
            <Textarea
              {...textareaProps}
              {...field}
              value={(field.value as string | undefined) ?? ""}
            />
          </FormControl>
          {description ? <FormDescription>{description}</FormDescription> : null}
          <FormMessage />
        </FormItem>
      )}
    />
  );
}

export interface SelectOption {
  value: string;
  label: ReactNode;
  disabled?: boolean;
  /** Secondary line shown in the dropdown. */
  hint?: ReactNode;
}

export interface SelectFieldProps<
  TFieldValues extends FieldValues,
  TName extends FieldPath<TFieldValues>,
> extends BaseFieldProps<TFieldValues, TName> {
  options: readonly SelectOption[];
  placeholder?: string;
  disabled?: boolean;
}

export function SelectField<
  TFieldValues extends FieldValues,
  TName extends FieldPath<TFieldValues>,
>({
  control,
  name,
  label,
  description,
  className,
  options,
  placeholder = "Select…",
  disabled,
}: SelectFieldProps<TFieldValues, TName>) {
  return (
    <FormField<TFieldValues, TName, unknown>
      control={control}
      name={name}
      render={({ field }) => (
        <FormItem className={className}>
          <FormLabel>{label}</FormLabel>
          <Select
            value={(field.value as string | undefined) ?? ""}
            onValueChange={field.onChange}
            disabled={disabled || field.disabled}
            name={field.name}
          >
            <FormControl>
              <SelectTrigger className="w-full" onBlur={field.onBlur} ref={field.ref}>
                <SelectValue placeholder={placeholder} />
              </SelectTrigger>
            </FormControl>
            <SelectContent>
              {options.map((option) => (
                <SelectItem key={option.value} value={option.value} disabled={option.disabled}>
                  {option.hint ? (
                    <span className="flex flex-col">
                      <span>{option.label}</span>
                      <span className="text-muted-foreground text-xs">{option.hint}</span>
                    </span>
                  ) : (
                    option.label
                  )}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {description ? <FormDescription>{description}</FormDescription> : null}
          <FormMessage />
        </FormItem>
      )}
    />
  );
}

export function SwitchField<
  TFieldValues extends FieldValues,
  TName extends FieldPath<TFieldValues>,
>({
  control,
  name,
  label,
  description,
  className,
  disabled,
}: BaseFieldProps<TFieldValues, TName> & { disabled?: boolean }) {
  return (
    <FormField<TFieldValues, TName, unknown>
      control={control}
      name={name}
      render={({ field }) => (
        <FormItem
          className={cn("flex items-start justify-between gap-4 rounded-lg border p-4", className)}
        >
          <div className="space-y-1">
            <FormLabel>{label}</FormLabel>
            {description ? <FormDescription>{description}</FormDescription> : null}
          </div>
          <FormControl>
            <Switch
              checked={Boolean(field.value)}
              onCheckedChange={field.onChange}
              onBlur={field.onBlur}
              disabled={disabled || field.disabled}
              ref={field.ref}
            />
          </FormControl>
        </FormItem>
      )}
    />
  );
}

/** Form-level error (anything that isn't a field error), with human copy. */
export function FormErrorAlert({
  error,
  title,
  className,
}: {
  error: unknown;
  title?: string;
  className?: string;
}) {
  if (!error) return null;
  return (
    <InlineAlert variant="danger" title={title} className={className}>
      {getErrorMessage(error)}
    </InlineAlert>
  );
}

export interface SubmitButtonProps extends Omit<ComponentProps<typeof Button>, "type"> {
  isPending?: boolean;
  /** Label while pending, e.g. "Signing in…". Defaults to the normal label. */
  pendingLabel?: ReactNode;
}

export function SubmitButton({
  isPending = false,
  pendingLabel,
  children,
  disabled,
  ...props
}: SubmitButtonProps) {
  return (
    <Button
      type="submit"
      disabled={disabled || isPending}
      aria-busy={isPending || undefined}
      {...props}
    >
      {isPending ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : null}
      {isPending && pendingLabel ? pendingLabel : children}
    </Button>
  );
}
