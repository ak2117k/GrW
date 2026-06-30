export type SignupErrors = Partial<
  Record<'email' | 'password' | 'confirm' | 'displayName', string>
>;

export interface SignupInput {
  email: string;
  password: string;
  confirm: string;
  displayName?: string;
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateSignup(input: SignupInput): SignupErrors {
  const errors: SignupErrors = {};

  if (!EMAIL_REGEX.test(input.email)) {
    errors.email = 'Enter a valid email address';
  }

  if (input.password.length < 8 || input.password.length > 128) {
    errors.password = 'Password must be between 8 and 128 characters';
  }

  if (input.confirm !== input.password) {
    errors.confirm = 'Passwords do not match';
  }

  if (input.displayName && input.displayName.length > 120) {
    errors.displayName = 'Display name must be 120 characters or fewer';
  }

  return errors;
}
