import React, { useState, useEffect } from 'react';
import { Form, Modal, Button } from 'react-bootstrap';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useContent } from '../contexts/ContentContext';
import { useNavigate } from 'react-router-dom';
import { ContentSubmission } from '../types/content';
import LexicalEditorComponent from './editor/LexicalEditor';
import { User } from '../types';
import { API_URL } from '../config';
import './CommsRequest.css';

const commsRequestSchema = z.object({
  email: z.string().email('Please enter a valid email address'),
  owner: z.string().min(1, 'Owner is required'),
  publishBy: z.string().min(1, 'Publish date is required'),
  urgentRequest: z.boolean().optional(),
  audience: z.array(z.string()).min(1, 'Please select at least one audience'),
  otherAudienceText: z.string().optional(),
  description: z.string().min(1, 'Description is required'),
  suggestedSubjectLine: z.string().min(1, 'Subject line is required'),
  replyToAddress: z.string().email('Please enter a valid reply-to email address'),
  text: z.string().optional(),
  signatureText: z.string().min(1, 'Signature text is required'),
  notes: z.string().optional(),
});

type CommsRequestFormData = z.infer<typeof commsRequestSchema>;

const STEPS = [
  { label: 'Details', number: 1 },
  { label: 'Content', number: 2 },
  { label: 'Review', number: 3 },
];

const AUDIENCE_LABELS: Record<string, string> = {
  newsletter: 'Include in Ranger Newsletter (sent over Ranger Announce)',
  singular: 'Singular announcement (outside of Ranger Newsletter)',
  allcom: 'Allcom',
  website_fix: 'Website - fix',
  website_update: 'Website - update',
  jrs: 'JRS/Event Ops/Other BMP Audience',
  event: "Let's plan an event",
  other: 'Other',
};

export const CommsRequest: React.FC = () => {
  const [step, setStep] = useState(1);
  const [showSuccess, setShowSuccess] = useState(false);
  const [editorContent, setEditorContent] = useState('');
  const [stepErrors, setStepErrors] = useState<string[]>([]);
  const { saveSubmission } = useContent();
  const navigate = useNavigate();

  const userJson = localStorage.getItem('user');
  const user = userJson ? JSON.parse(userJson) : null;
  const userEmail = user?.email || '';
  const userId = user?.id || user?.email || '';

  const {
    register,
    handleSubmit,
    formState: { errors },
    reset,
    setValue,
    getValues,
    trigger,
    watch,
  } = useForm<CommsRequestFormData>({
    resolver: zodResolver(commsRequestSchema),
    defaultValues: {
      email: userEmail,
      audience: [],
      urgentRequest: false,
      otherAudienceText: '',
    },
  });

  const publishByValue = watch('publishBy');
  const audienceValue = watch('audience');
  const urgentRequestValue = watch('urgentRequest');
  const otherAudienceTextValue = watch('otherAudienceText');

  const getMinDate = () => {
    const days = urgentRequestValue ? 1 : 7;
    const d = new Date();
    d.setDate(d.getDate() + days);
    return d.toISOString().split('T')[0];
  };

  const formatDate = (dateStr: string): string => {
    if (!dateStr) return '';
    const [year, month, day] = dateStr.split('-').map(Number);
    const date = new Date(year, month - 1, day);
    return date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  };

  const [allUsers, setAllUsers] = useState<User[]>([]);
  const [councilManagers, setCouncilManagers] = useState<any[]>([]);
  const [formError, setFormError] = useState<string | null>(null);
  const [approverEmails, setApproverEmails] = useState<string[]>(['']);
  const [suggestions, setSuggestions] = useState<{ [key: number]: User[] }>({});
  const [activeSuggestionIndex, setActiveSuggestionIndex] = useState<{ [key: number]: number }>({});

  useEffect(() => {
    const fetchUsers = async () => {
      try {
        const sessionId = localStorage.getItem('sessionId');
        if (!sessionId) return;

        const usersResponse = await fetch(`${API_URL}/admin/users`, {
          headers: { Authorization: `Bearer ${sessionId}` },
        });
        if (!usersResponse.ok) throw new Error('Failed to fetch users');
        const usersData = await usersResponse.json();
        setAllUsers(usersData.users || []);

        const managersResponse = await fetch(`${API_URL}/council/members`, {
          headers: { Authorization: `Bearer ${sessionId}` },
        });
        if (!managersResponse.ok) throw new Error('Failed to fetch council managers');
        const managersData = await managersResponse.json();
        setCouncilManagers(managersData);
      } catch (error) {
        console.error('Error fetching users:', error);
      }
    };
    fetchUsers();
  }, []);

  const handleEditorChange = (_editor: any, json: string) => {
    setEditorContent(json);
    setValue('text', json);
  };

  const showCouncilManagerDefaults = (index: number) => {
    const cmUsers = allUsers.filter((u) =>
      councilManagers.some((m) => m.email === u.email)
    );
    if (cmUsers.length > 0) {
      setSuggestions((prev) => ({ ...prev, [index]: cmUsers }));
      setActiveSuggestionIndex((prev) => ({ ...prev, [index]: 0 }));
    }
  };

  const handleEmailChange = (index: number, value: string) => {
    const newEmails = [...approverEmails];
    newEmails[index] = value;
    setApproverEmails(newEmails);

    if (value && allUsers.length > 0) {
      const filtered = allUsers.filter(
        (u) =>
          u.email.toLowerCase().includes(value.toLowerCase()) ||
          (u.name && u.name.toLowerCase().includes(value.toLowerCase()))
      );
      setSuggestions((prev) => ({ ...prev, [index]: filtered }));
      setActiveSuggestionIndex((prev) => ({ ...prev, [index]: 0 }));
    } else if (!value) {
      showCouncilManagerDefaults(index);
    } else {
      setSuggestions((prev) => ({ ...prev, [index]: [] }));
      setActiveSuggestionIndex((prev) => ({ ...prev, [index]: 0 }));
    }
  };

  const handleSuggestionClick = async (index: number, email: string) => {
    const newEmails = [...approverEmails];
    newEmails[index] = email;
    setApproverEmails(newEmails);
    setSuggestions((prev) => ({ ...prev, [index]: [] }));

    const isCouncilManager = councilManagers.some((m) => m.email === email);
    if (!isCouncilManager) {
      try {
        const sessionId = localStorage.getItem('sessionId');
        if (!sessionId) return;
        const response = await fetch(`${API_URL}/admin/council-managers`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${sessionId}`,
          },
          body: JSON.stringify({ email, role: 'CommunicationsManager', action: 'add' }),
        });
        if (response.ok) {
          const managersResponse = await fetch(`${API_URL}/council/members`, {
            headers: { Authorization: `Bearer ${sessionId}` },
          });
          if (managersResponse.ok) {
            setCouncilManagers(await managersResponse.json());
          }
        }
      } catch (error) {
        console.error('Error updating council manager:', error);
      }
    }
  };

  const handleEmailKeyDown = (index: number, e: React.KeyboardEvent<any>) => {
    if (!suggestions[index] || suggestions[index].length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveSuggestionIndex((prev) => ({
        ...prev,
        [index]: Math.min((prev[index] ?? 0) + 1, suggestions[index].length - 1),
      }));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveSuggestionIndex((prev) => ({
        ...prev,
        [index]: Math.max((prev[index] ?? 0) - 1, 0),
      }));
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      const activeIdx = activeSuggestionIndex[index] ?? 0;
      if (suggestions[index][activeIdx]) {
        handleSuggestionClick(index, suggestions[index][activeIdx].email);
      }
    }
  };

  const addApproverField = () => setApproverEmails([...approverEmails, '']);

  const removeApproverField = (index: number) => {
    if (approverEmails.length === 1) return;
    setApproverEmails(approverEmails.filter((_, i) => i !== index));
    setSuggestions((prev) => {
      const next = { ...prev };
      delete next[index];
      return next;
    });
    setActiveSuggestionIndex((prev) => {
      const next = { ...prev };
      delete next[index];
      return next;
    });
  };

  // Step validation before advancing
  const validateStep = async (currentStep: number): Promise<boolean> => {
    setStepErrors([]);
    setFormError(null);

    if (currentStep === 1) {
      const fieldsToValidate: (keyof CommsRequestFormData)[] = [
        'email',
        'replyToAddress',
        'owner',
        'publishBy',
        'audience',
      ];
      const valid = await trigger(fieldsToValidate);

      const currentAudience = getValues('audience') || [];
      if (currentAudience.includes('other')) {
        const otherText = getValues('otherAudienceText') || '';
        if (!otherText.trim()) {
          setFormError('Please describe your "Other" audience');
          return false;
        }
      }

      const validApprovers = approverEmails.filter((e) => e.trim() !== '');
      if (validApprovers.length === 0) {
        setFormError('At least one approver is required');
        return false;
      }
      return valid;
    }

    if (currentStep === 2) {
      const fieldsToValidate: (keyof CommsRequestFormData)[] = [
        'description',
        'suggestedSubjectLine',
        'signatureText',
      ];
      return await trigger(fieldsToValidate);
    }

    return true;
  };

  const goNext = async () => {
    const valid = await validateStep(step);
    if (valid) setStep((s) => Math.min(s + 1, 3));
  };

  const goBack = () => setStep((s) => Math.max(s - 1, 1));

  const onSubmit = async (data: CommsRequestFormData) => {
    try {
      const validApprovers = approverEmails.filter((e) => e.trim() !== '');
      if (validApprovers.length === 0) {
        setFormError('At least one approver is required');
        return;
      }

      const submission: Partial<ContentSubmission> = {
        id: crypto.randomUUID(),
        title: data.suggestedSubjectLine,
        content: data.text || '',
        richTextContent: editorContent,
        status: 'in_review',
        submittedBy: userId,
        submittedAt: new Date(),
        formFields: [
          { id: 'owner', label: 'Owner', value: data.owner, type: 'text', required: true },
          { id: 'publishBy', label: 'Publish By', value: data.publishBy, type: 'date', required: true },
          { id: 'urgentRequest', label: 'Urgent Request', value: data.urgentRequest ? 'Yes' : 'No', type: 'text', required: false },
          { id: 'audience', label: 'Audience', value: data.audience.map((a) =>
            a === 'other' && data.otherAudienceText ? `Other: ${data.otherAudienceText}` : AUDIENCE_LABELS[a] || a
          ).join(', '), type: 'text', required: true },
          { id: 'description', label: 'Description', value: data.description, type: 'text', required: true },
          { id: 'replyToAddress', label: 'Reply-To Address', value: data.replyToAddress, type: 'text', required: true },
          { id: 'signatureText', label: 'Signature Text', value: data.signatureText, type: 'text', required: true },
          { id: 'notes', label: 'Notes', value: data.notes || '', type: 'text', required: false },
        ],
        comments: [],
        approvals: [],
        changes: [],
        assignedReviewers: [],
        assignedCouncilManagers: [],
        requiredApprovers: validApprovers,
      };

      await saveSubmission(submission as ContentSubmission);
      setShowSuccess(true);
      reset();
      setEditorContent('');
      setApproverEmails(['']);
      setStep(1);
    } catch (error) {
      console.error('Error submitting form:', error);
    }
  };

  const handleViewSubmissions = () => {
    setShowSuccess(false);
    navigate('/requests');
  };

  const values = getValues();

  // --- Render helpers ---

  const renderStepper = () => (
    <div className="wizard-stepper">
      {STEPS.map((s, i) => (
        <React.Fragment key={s.number}>
          <div className="step-node">
            <div
              className={`step-circle ${step === s.number ? 'active' : ''} ${step > s.number ? 'completed' : ''}`}
            >
              {step > s.number ? '✓' : s.number}
            </div>
            <div
              className={`step-label ${step === s.number ? 'active' : ''} ${step > s.number ? 'completed' : ''}`}
            >
              {s.label}
            </div>
          </div>
          {i < STEPS.length - 1 && (
            <div className={`step-connector ${step > s.number ? 'completed' : ''}`} />
          )}
        </React.Fragment>
      ))}
    </div>
  );

  const renderStep1 = () => (
    <>
      <div className="wizard-card">
        <div className="wizard-card-header">
          <h3>Contact Information</h3>
        </div>
        <div className="form-row">
          <div className="form-field">
            <label>Email <span className="required">*</span></label>
            <Form.Control type="email" {...register('email')} readOnly />
          </div>
          <div className="form-field">
            <label>Reply-To Address <span className="required">*</span></label>
            <Form.Control
              type="email"
              {...register('replyToAddress')}
              placeholder="Who should recipients reply to?"
            />
            {errors.replyToAddress && (
              <div className="field-error">{errors.replyToAddress.message}</div>
            )}
          </div>
        </div>
      </div>

      <div className="wizard-card">
        <div className="wizard-card-header">
          <h3>Request Details</h3>
        </div>

        <div className="form-row">
          <div className="form-field">
            <label>Owner <span className="required">*</span></label>
            <Form.Control
              type="text"
              {...register('owner')}
              placeholder="Who owns this content?"
            />
            <div className="field-hint">Cadre, team, or individual responsible for accuracy</div>
            {errors.owner && <div className="field-error">{errors.owner.message}</div>}
          </div>
          <div className="form-field">
            <label>Publish By <span className="required">*</span></label>
            <Form.Control
              type="date"
              {...register('publishBy')}
              min={getMinDate()}
              onClick={(e: React.MouseEvent<HTMLInputElement>) => {
                try { e.currentTarget.showPicker(); } catch {}
              }}
            />
            {publishByValue && (
              <div className="field-hint">{formatDate(publishByValue)}</div>
            )}
            {!urgentRequestValue && (
              <div className="field-hint">Dates must be at least 7 days from today</div>
            )}
            {errors.publishBy && <div className="field-error">{errors.publishBy.message}</div>}
          </div>
        </div>

        <div className="form-field">
          <label
            className={`urgent-checkbox-label ${urgentRequestValue ? 'checked' : ''}`}
          >
            <input
              type="checkbox"
              {...register('urgentRequest')}
            />
            <span>This is an urgent request</span>
          </label>
          {urgentRequestValue && (
            <div className="urgent-help-text">
              Is this an urgent request that will require less than a week's turnaround time?
              Please note that Comms might not always be able to meet last-minute requests.
              If you need a fast turnaround, please also send an email to{' '}
              <a href="mailto:ranger-comm-cadre-list@burningman.org">
                ranger-comm-cadre-list@burningman.org
              </a>{' '}
              to let us know, and please try to give us more notice next time. Thanks!
            </div>
          )}
        </div>

        <div className="form-field">
          <label>Audience <span className="required">*</span></label>
          <div className="audience-grid">
            {Object.entries(AUDIENCE_LABELS).map(([value, label]) => {
              const checked = audienceValue?.includes(value) ?? false;
              return (
                <label key={value} className={`audience-option ${checked ? 'selected' : ''}`}>
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => {
                      const current = audienceValue || [];
                      const next = checked
                        ? current.filter((v: string) => v !== value)
                        : [...current, value];
                      setValue('audience', next, { shouldValidate: true });
                    }}
                  />
                  <span className="audience-label">{label}</span>
                </label>
              );
            })}
          </div>
          {audienceValue?.includes('other') && (
            <div className="other-audience-field">
              <Form.Control
                type="text"
                {...register('otherAudienceText')}
                placeholder="Please describe your audience..."
              />
            </div>
          )}
          {errors.audience && <div className="field-error">{errors.audience.message}</div>}
        </div>
      </div>

      <div className="wizard-card">
        <div className="wizard-card-header">
          <h3>Required Approvers</h3>
          <p>Add at least one approver who will review this request.</p>
        </div>

        <div className="approver-list">
          {approverEmails.map((email, index) => {
            const items = suggestions[index] || [];
            const activeIdx = activeSuggestionIndex[index] ?? 0;
            const showDropdown = items.length > 0;

            return (
              <div key={index} className="approver-row">
                <div className="approver-input-wrap">
                  <Form.Control
                    type="email"
                    value={email}
                    onChange={(e) => handleEmailChange(index, e.target.value)}
                    onKeyDown={(e) => handleEmailKeyDown(index, e)}
                    onFocus={() => {
                      if (!email) showCouncilManagerDefaults(index);
                    }}
                    onBlur={() => {
                      setTimeout(() => {
                        setSuggestions((prev) => ({ ...prev, [index]: [] }));
                      }, 150);
                    }}
                    placeholder="Search by name or email..."
                    autoComplete="off"
                    spellCheck={false}
                  />
                  {showDropdown && (
                    <div className="approver-dropdown">
                      {items.slice(0, 6).map((u, i) => {
                        const isManager = councilManagers.some((m) => m.email === u.email);
                        return (
                          <div
                            key={u.email}
                            className={`approver-dropdown-item ${i === activeIdx ? 'active' : ''}`}
                            onMouseDown={(e) => {
                              e.preventDefault();
                              handleSuggestionClick(index, u.email);
                            }}
                          >
                            <div className="approver-dropdown-info">
                              <span className="approver-dropdown-name">
                                {u.name || u.email.split('@')[0]}
                              </span>
                              <span className="approver-dropdown-email">{u.email}</span>
                            </div>
                            {isManager && (
                              <span className="approver-badge-cm">Council Manager</span>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
                {approverEmails.length > 1 && (
                  <button
                    type="button"
                    className="remove-approver-btn"
                    onClick={() => removeApproverField(index)}
                    title="Remove approver"
                  >
                    &times;
                  </button>
                )}
              </div>
            );
          })}
        </div>

        <button type="button" className="add-approver-btn" onClick={addApproverField}>
          + Add Approver
        </button>

        {formError && <div className="field-error" style={{ marginTop: 8 }}>{formError}</div>}
      </div>
    </>
  );

  const renderStep2 = () => (
    <>
      <div className="wizard-card">
        <div className="wizard-card-header">
          <h3>Content</h3>
          <p>Describe what you need communicated and provide any draft text.</p>
        </div>

        <div className="form-field">
          <label>Description <span className="required">*</span></label>
          <Form.Control
            as="textarea"
            rows={3}
            {...register('description')}
            placeholder="Briefly describe the document this request is about"
          />
          {errors.description && <div className="field-error">{errors.description.message}</div>}
        </div>

        <div className="form-field">
          <label>Suggested Subject Line <span className="required">*</span></label>
          <Form.Control
            type="text"
            {...register('suggestedSubjectLine')}
            placeholder="What should the subject line say?"
          />
          {errors.suggestedSubjectLine && (
            <div className="field-error">{errors.suggestedSubjectLine.message}</div>
          )}
        </div>

        <div className="form-field">
          <label>Text</label>
          <div className="field-hint" style={{ marginBottom: 8 }}>
            Include any text you'd like us to use, or paste content and links here.
          </div>
          <LexicalEditorComponent
            initialContent={editorContent}
            onChange={handleEditorChange}
            placeholder="Start typing or paste your content..."
            className="h-64"
            currentUserId={userId}
          />
        </div>

        <div className="form-field">
          <label>Signature Text <span className="required">*</span></label>
          <Form.Control
            type="text"
            {...register('signatureText')}
            placeholder="What text do you want at the end of the email?"
          />
          {errors.signatureText && (
            <div className="field-error">{errors.signatureText.message}</div>
          )}
        </div>
      </div>
    </>
  );

  const renderStep3 = () => {
    const v = getValues();
    const validApprovers = approverEmails.filter((e) => e.trim() !== '');

    return (
      <>
        <div className="wizard-card">
          <div className="wizard-card-header">
            <h3>Review Your Request</h3>
            <p>Please review the details below before submitting.</p>
          </div>

          <div className="review-section">
            <h4>Contact & Details</h4>
            <div className="review-grid">
              <div className="review-item">
                <span className="review-label">Email</span>
                <span className="review-value">{v.email}</span>
              </div>
              <div className="review-item">
                <span className="review-label">Reply-To</span>
                <span className="review-value">{v.replyToAddress || <em className="review-value empty">Not set</em>}</span>
              </div>
              <div className="review-item">
                <span className="review-label">Owner</span>
                <span className="review-value">{v.owner || <em className="review-value empty">Not set</em>}</span>
              </div>
              <div className="review-item">
                <span className="review-label">Publish By</span>
                <span className="review-value">
                  {v.publishBy ? formatDate(v.publishBy) : <em className="review-value empty">Not set</em>}
                  {v.urgentRequest && <span className="badge badge-urgent" style={{ marginLeft: 8 }}>Urgent</span>}
                </span>
              </div>
              <div className="review-item full-width">
                <span className="review-label">Audience</span>
                <span className="review-value">
                  {v.audience && v.audience.length > 0
                    ? v.audience.map((a: string) =>
                        a === 'other' && v.otherAudienceText
                          ? `Other: ${v.otherAudienceText}`
                          : AUDIENCE_LABELS[a] || a
                      ).join(', ')
                    : <em className="review-value empty">Not set</em>}
                </span>
              </div>
              <div className="review-item full-width">
                <span className="review-label">Approvers</span>
                <span className="review-value">
                  {validApprovers.length > 0
                    ? validApprovers.join(', ')
                    : <em className="review-value empty">None</em>}
                </span>
              </div>
            </div>
          </div>

          <div className="review-section">
            <h4>Content</h4>
            <div className="review-grid">
              <div className="review-item full-width">
                <span className="review-label">Description</span>
                <span className="review-value">{v.description || <em className="review-value empty">Not provided</em>}</span>
              </div>
              <div className="review-item full-width">
                <span className="review-label">Subject Line</span>
                <span className="review-value">{v.suggestedSubjectLine || <em className="review-value empty">Not provided</em>}</span>
              </div>
              <div className="review-item full-width">
                <span className="review-label">Body Text</span>
                <span className="review-value">
                  {editorContent ? 'Rich text content provided' : <em className="review-value empty">None</em>}
                </span>
              </div>
              <div className="review-item full-width">
                <span className="review-label">Signature</span>
                <span className="review-value">{v.signatureText || <em className="review-value empty">Not provided</em>}</span>
              </div>
            </div>
          </div>

          <div className="form-field" style={{ marginTop: 16 }}>
            <label>Notes</label>
            <Form.Control
              as="textarea"
              rows={3}
              {...register('notes')}
              placeholder="Notes, questions, issues, or anything else you want us to know"
            />
          </div>
        </div>
      </>
    );
  };

  return (
    <div className="comms-wizard">
      <div className="wizard-intro">
        <h2>New Comms Request</h2>
        <p>
          Ranger Communications can write, edit, and help you get your message out.
        </p>
      </div>

      {renderStepper()}

      <Form
        onSubmit={handleSubmit(
          (data) => onSubmit(data),
          () => {}
        )}
      >
        {step === 1 && renderStep1()}
        {step === 2 && renderStep2()}
        {step === 3 && renderStep3()}

        <div className="wizard-nav">
          {step > 1 ? (
            <button type="button" className="btn-back" onClick={goBack}>
              Back
            </button>
          ) : (
            <div />
          )}

          {step < 3 ? (
            <button type="button" className="btn-next" onClick={goNext}>
              Next
            </button>
          ) : (
            <button type="submit" className="btn-submit">
              Submit Request
            </button>
          )}
        </div>
      </Form>

      <Modal show={showSuccess} onHide={() => setShowSuccess(false)} centered>
        <Modal.Header closeButton>
          <Modal.Title>Request Submitted!</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <p>Your comms request has been submitted and is now under review.</p>
          <p style={{ marginTop: 12 }}>
            You can track the status of your request in the submissions area.
          </p>
        </Modal.Body>
        <Modal.Footer>
          <Button variant="secondary" onClick={() => setShowSuccess(false)}>
            Close
          </Button>
          <Button variant="primary" onClick={handleViewSubmissions}>
            View Submissions
          </Button>
        </Modal.Footer>
      </Modal>
    </div>
  );
};

export default CommsRequest;
