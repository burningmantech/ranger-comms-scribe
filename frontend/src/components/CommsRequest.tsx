import React, { useState, useEffect } from 'react';
import { Form, Button, Alert, Modal } from 'react-bootstrap';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useContent } from '../contexts/ContentContext';
import { Link, useNavigate } from 'react-router-dom';
import { ContentSubmission, FormField, CouncilRole } from '../types/content';
import LexicalEditorComponent from './editor/LexicalEditor';
import { User } from '../types';
import { API_URL } from '../config';
import './CommsRequest.css';

// Define the form schema using Zod
const commsRequestSchema = z.object({
  email: z.string().email('Please enter a valid email address'),
  owner: z.string().min(1, 'Owner is required'),
  requiredApprovers: z.string().min(1, 'Required approvers are required'),
  publishBy: z.string().min(1, 'Publish date is required'),
  urgency: z.enum(['no', 'yes'], {
    required_error: 'Please select an urgency level',
  }),
  audience: z.string().min(1, 'Please select an audience'),
  description: z.string().min(1, 'Description is required'),
  suggestedSubjectLine: z.string().min(1, 'Subject line is required'),
  replyToAddress: z.string().email('Please enter a valid reply-to email address'),
  text: z.string().optional(),
  signatureText: z.string().min(1, 'Signature text is required'),
  notes: z.string().optional(),
});

type CommsRequestFormData = z.infer<typeof commsRequestSchema>;

export const CommsRequest: React.FC = () => {
  const [showSuccess, setShowSuccess] = useState(false);
  const [editorContent, setEditorContent] = useState('');
  const { saveSubmission } = useContent();
  const navigate = useNavigate();
  
  // Get the logged-in user's email from localStorage
  const userJson = localStorage.getItem('user');
  const userEmail = userJson ? JSON.parse(userJson).email : '';
  
  const {
    register,
    handleSubmit,
    formState: { errors },
    reset,
    setValue,
  } = useForm<CommsRequestFormData>({
    resolver: zodResolver(commsRequestSchema),
    defaultValues: {
      email: userEmail, // Use the logged-in user's email instead of hardcoded value
    },
  });

  const [allUsers, setAllUsers] = useState<User[]>([]);
  const [councilManagers, setCouncilManagers] = useState<User[]>([]);
  const [selectedApprovers, setSelectedApprovers] = useState<string[]>([]);
  const [formError, setFormError] = useState<string | null>(null);
  const [approverEmails, setApproverEmails] = useState<string[]>(['']);
  const [suggestions, setSuggestions] = useState<{ [key: number]: User[] }>({});
  const [activeSuggestionIndex, setActiveSuggestionIndex] = useState<{ [key: number]: number }>({});

  // Fetch all users and council managers when component mounts
  useEffect(() => {
    const fetchUsers = async () => {
      try {
        const sessionId = localStorage.getItem('sessionId');
        if (!sessionId) return;

        // Fetch all users
        const usersResponse = await fetch(`${API_URL}/admin/users`, {
          headers: {
            Authorization: `Bearer ${sessionId}`,
          },
        });
        
        if (!usersResponse.ok) {
          throw new Error('Failed to fetch users');
        }
        
        const usersData = await usersResponse.json();
        console.log('Fetched users:', usersData);
        // Extract the users array from the response
        setAllUsers(usersData.users || []);

        // Fetch council managers
        const managersResponse = await fetch(`${API_URL}/admin/council-managers`, {
          headers: {
            Authorization: `Bearer ${sessionId}`,
          },
        });
        
        if (!managersResponse.ok) {
          throw new Error('Failed to fetch council managers');
        }
        
        const managersData = await managersResponse.json();
        console.log('Fetched council managers:', managersData);
        setCouncilManagers(managersData);
      } catch (error) {
        console.error('Error fetching users:', error);
      }
    };

    fetchUsers();
  }, []);

  const handleEditorChange = (editor: any, json: string) => {
    setEditorContent(json);
    setValue('text', json);
  };

  const handleEmailChange = (index: number, value: string) => {
    const newEmails = [...approverEmails];
    newEmails[index] = value;
    setApproverEmails(newEmails);

    // Filter suggestions based on input
    if (value && allUsers.length > 0) {
      const filtered = allUsers.filter(user => 
        user.email.toLowerCase().includes(value.toLowerCase()) ||
        (user.name && user.name.toLowerCase().includes(value.toLowerCase()))
      );
      console.log('Filtered suggestions:', filtered);
      setSuggestions(prev => ({ ...prev, [index]: filtered }));
      setActiveSuggestionIndex(prev => ({ ...prev, [index]: 0 }));
    } else {
      setSuggestions(prev => ({ ...prev, [index]: [] }));
      setActiveSuggestionIndex(prev => ({ ...prev, [index]: 0 }));
    }
  };

  const handleSuggestionClick = async (index: number, email: string) => {
    const newEmails = [...approverEmails];
    newEmails[index] = email;
    setApproverEmails(newEmails);
    setSuggestions(prev => ({ ...prev, [index]: [] }));

    // If this is a council manager, ensure they're properly registered
    const isCouncilManager = councilManagers.some(manager => manager.email === email);
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
          body: JSON.stringify({
            email,
            role: 'COMMUNICATIONS_MANAGER',
            action: 'add'
          })
        });

        if (!response.ok) {
          const error = await response.json();
          console.error('Failed to add council manager:', error);
          return;
        }

        // Refresh council managers list
        const managersResponse = await fetch(`${API_URL}/admin/council-managers`, {
          headers: {
            Authorization: `Bearer ${sessionId}`,
          },
        });
        
        if (managersResponse.ok) {
          const managersData = await managersResponse.json();
          setCouncilManagers(managersData);
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
      setActiveSuggestionIndex(prev => ({
        ...prev,
        [index]: Math.min((prev[index] ?? 0) + 1, suggestions[index].length - 1)
      }));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveSuggestionIndex(prev => ({
        ...prev,
        [index]: Math.max((prev[index] ?? 0) - 1, 0)
      }));
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      const activeIdx = activeSuggestionIndex[index] ?? 0;
      if (suggestions[index][activeIdx]) {
        handleSuggestionClick(index, suggestions[index][activeIdx].email);
      }
    }
  };

  const addApproverField = () => {
    setApproverEmails([...approverEmails, '']);
  };

  const removeApproverField = (index: number) => {
    if (approverEmails.length === 1) return;
    const newEmails = approverEmails.filter((_, i) => i !== index);
    setApproverEmails(newEmails);
    setSuggestions(prev => {
      const newSuggestions = { ...prev };
      delete newSuggestions[index];
      return newSuggestions;
    });
    setActiveSuggestionIndex(prev => {
      const newActive = { ...prev };
      delete newActive[index];
      return newActive;
    });
  };

  const onSubmit = async (data: CommsRequestFormData) => {
    try {
      // Filter out empty email fields
      const validApprovers = approverEmails.filter(email => email.trim() !== '');
      
      if (validApprovers.length === 0) {
        setFormError('At least one approver is required');
        return;
      }

      // Check if at least one council manager is selected
      const hasCouncilManager = validApprovers.some(email => 
        councilManagers.some(manager => manager.email === email)
      );

      if (!hasCouncilManager) {
        setFormError('At least one council manager must be selected as an approver');
        return;
      }

      // Create a content submission from the form data
      const submission: Partial<ContentSubmission> = {
        id: crypto.randomUUID(),
        title: data.suggestedSubjectLine,
        content: data.text || '',
        richTextContent: editorContent,
        status: 'in_review',
        submittedBy: userEmail,
        submittedAt: new Date(),
        formFields: [
          { id: 'owner', label: 'Owner', value: data.owner, type: 'text', required: true },
          { id: 'publishBy', label: 'Publish By', value: data.publishBy, type: 'date', required: true },
          { id: 'urgency', label: 'Urgency', value: data.urgency, type: 'text', required: true },
          { id: 'audience', label: 'Audience', value: data.audience, type: 'text', required: true },
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
        requiredApprovers: validApprovers
      };

      await saveSubmission(submission as ContentSubmission);
      setShowSuccess(true);
      reset();
      setEditorContent('');
      setSelectedApprovers([]);
    } catch (error) {
      console.error('Error submitting form:', error);
    }
  };

  const handleViewSubmissions = () => {
    setShowSuccess(false);
    navigate('/requests');
  };

  return (
    <div className="content-management">
      <div className="content-body">
        <h2>Comms Request</h2>
        <p className="mb-4">
          Ranger Communications can write, edit, facilitate and make your message heard. 
          We can help you tell the Rangers what you need them to know.
        </p>

        <Form onSubmit={handleSubmit(onSubmit)}>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Contact Information */}
            <div className="col-span-2">
              <h3 className="text-lg font-semibold mb-3">Contact Information</h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <Form.Group>
                  <Form.Label>Email *</Form.Label>
                  <Form.Control
                    type="email"
                    {...register('email')}
                    readOnly
                  />
                </Form.Group>

                <Form.Group>
                  <Form.Label>Reply-To Address *</Form.Label>
                  <Form.Control
                    type="email"
                    {...register('replyToAddress')}
                    placeholder="Who should recipients send their questions to?"
                  />
                  {errors.replyToAddress && (
                    <Form.Text className="text-danger">{errors.replyToAddress.message}</Form.Text>
                  )}
                </Form.Group>
              </div>
            </div>

            {/* Request Details */}
            <div className="col-span-2">
              <h3 className="text-lg font-semibold mb-3">Request Details</h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <Form.Group>
                  <Form.Label>Owner *</Form.Label>
                  <Form.Control
                    type="text"
                    {...register('owner')}
                    placeholder="Cadre, team, or individual responsible for making sure the content is accurate"
                  />
                  {errors.owner && (
                    <Form.Text className="text-danger">{errors.owner.message}</Form.Text>
                  )}
                </Form.Group>

                {/* Required Approvers Section */}
                <div className="col-span-2">
                  <h3 className="text-lg font-semibold mb-3">Required Approvers</h3>
                  <p className="text-sm text-gray-600 mb-3">
                    At least one council manager must be selected as an approver. You can also add other registered users or email addresses.
                  </p>
                  {approverEmails.map((email, index) => {
                    const suggestionUser = suggestions[index]?.[activeSuggestionIndex[index] ?? 0];
                    let completion = '';
                    let ghostName = '';
                    let ghostBadge = '';
                    if (suggestionUser) {
                      const inputValue = email.toLowerCase();
                      const emailLower = suggestionUser.email.toLowerCase();
                      if (emailLower.startsWith(inputValue)) {
                        completion = suggestionUser.email.slice(email.length);
                        ghostName = suggestionUser.name ? ` (${suggestionUser.name})` : '';
                        ghostBadge = councilManagers.some(manager => manager.email === suggestionUser.email)
                          ? '  Council Manager' : '';
                      }
                    }
                    return (
                      <div key={index} className="mb-3">
                        <div className="flex items-center gap-2">
                          <div className="flex-grow relative approver-field">
                            <div className="input-ghost-wrapper">
                              {completion && (
                                <span className="input-ghost-suggestion">
                                  {email}{completion}{ghostName}{ghostBadge}
                                </span>
                              )}
                              <Form.Control
                                type="email"
                                value={email}
                                onChange={(e) => handleEmailChange(index, e.target.value)}
                                onKeyDown={(e) => handleEmailKeyDown(index, e)}
                                placeholder="Enter approver email"
                                className="form-input"
                                autoComplete="off"
                                spellCheck={false}
                                style={{ background: 'transparent', position: 'relative', zIndex: 2 }}
                              />
                            </div>
                          </div>
                          {approverEmails.length > 1 && (
                            <Button
                              variant="danger"
                              size="sm"
                              onClick={() => removeApproverField(index)}
                              className="remove-approver-btn"
                            >
                              <i className="fas fa-times"></i>
                            </Button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                  <Button
                    variant="outline-primary"
                    onClick={addApproverField}
                    className="add-approver-btn mt-2"
                    type="button"
                  >
                    <i className="fas fa-plus"></i> Add Approver
                  </Button>
                  {formError && <div className="error-message mt-2">{formError}</div>}
                </div>

                <Form.Group>
                  <Form.Label>Publish By *</Form.Label>
                  <Form.Control
                    type="date"
                    {...register('publishBy')}
                  />
                  {errors.publishBy && (
                    <Form.Text className="text-danger">{errors.publishBy.message}</Form.Text>
                  )}
                </Form.Group>

                <Form.Group>
                  <Form.Label>Urgency *</Form.Label>
                  <Form.Select {...register('urgency')}>
                    <option value="">Select urgency level</option>
                    <option value="no">No, it can be included in the monthly newsletter</option>
                    <option value="yes">Yes, this is urgent</option>
                  </Form.Select>
                  {errors.urgency && (
                    <Form.Text className="text-danger">{errors.urgency.message}</Form.Text>
                  )}
                </Form.Group>

                <Form.Group>
                  <Form.Label>Audience *</Form.Label>
                  <Form.Select {...register('audience')}>
                    <option value="">Select audience</option>
                    <option value="newsletter">Monthly-ish Newsletter (sent over Ranger Announce)</option>
                    <option value="urgent">More urgent announcement (sent over Ranger Announce)</option>
                    <option value="allcom">Allcom (Can include off topic things, as well as copies of department announcements)</option>
                    <option value="website_fix">Website - something on the web site is wrong</option>
                    <option value="website_add">Website - something needs to be added</option>
                    <option value="jrs">JRS/Event Ops/Other BMP Audience</option>
                    <option value="event">Let's plan an event</option>
                    <option value="other">Other</option>
                  </Form.Select>
                  {errors.audience && (
                    <Form.Text className="text-danger">{errors.audience.message}</Form.Text>
                  )}
                </Form.Group>
              </div>
            </div>

            {/* Content Information */}
            <div className="col-span-2">
              <h3 className="text-lg font-semibold mb-3">Content Information</h3>
              <div className="grid grid-cols-1 gap-4">
                <Form.Group>
                  <Form.Label>Description *</Form.Label>
                  <Form.Control
                    as="textarea"
                    rows={3}
                    {...register('description')}
                    placeholder="Briefly describe the document this request is about"
                  />
                  {errors.description && (
                    <Form.Text className="text-danger">{errors.description.message}</Form.Text>
                  )}
                </Form.Group>

                <Form.Group>
                  <Form.Label>Suggested Subject Line *</Form.Label>
                  <Form.Control
                    type="text"
                    {...register('suggestedSubjectLine')}
                    placeholder="What should the subject line say?"
                  />
                  {errors.suggestedSubjectLine && (
                    <Form.Text className="text-danger">{errors.suggestedSubjectLine.message}</Form.Text>
                  )}
                </Form.Group>

                <Form.Group>
                  <Form.Label>Text</Form.Label>
                  <LexicalEditorComponent
                    initialContent={editorContent}
                    onChange={handleEditorChange}
                    placeholder="Include any text you'd like us to use or paste content and links here"
                    className="h-64"
                  />
                </Form.Group>

                <Form.Group>
                  <Form.Label>Signature Text *</Form.Label>
                  <Form.Control
                    type="text"
                    {...register('signatureText')}
                    placeholder="What text do you want at the end of the email?"
                  />
                  {errors.signatureText && (
                    <Form.Text className="text-danger">{errors.signatureText.message}</Form.Text>
                  )}
                </Form.Group>
              </div>
            </div>

            {/* Additional Information */}
            <div className="col-span-2">
              <h3 className="text-lg font-semibold mb-3">Additional Information</h3>
              <div className="grid grid-cols-1 gap-4">
                <Form.Group>
                  <Form.Label>Notes</Form.Label>
                  <Form.Control
                    as="textarea"
                    rows={3}
                    {...register('notes')}
                    placeholder="Notes, questions, issues, etc.; anything you want us to know about this project"
                  />
                </Form.Group>
              </div>
            </div>
          </div>

          <div className="mt-6 flex justify-end">
            <Button variant="primary" type="submit" className="submit-button">
              Submit Comms Request
            </Button>
          </div>
        </Form>

        <Modal show={showSuccess} onHide={() => setShowSuccess(false)} centered>
          <Modal.Header closeButton>
            <Modal.Title>Request Submitted Successfully!</Modal.Title>
          </Modal.Header>
          <Modal.Body>
            <p>Your comms request has been submitted and is now under review.</p>
            <p className="mt-3">
              You can track the status of your request and add comments in the submissions area.
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
    </div>
  );
};

export default CommsRequest; 