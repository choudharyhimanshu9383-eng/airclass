import { requireSupabase } from "./supabase.js";

const MATERIAL_BUCKET = "lesson-files";

export async function signUpPortal({
  email,
  password,
  role,
  name,
  className,
  classCode,
}) {
  const client = requireSupabase();
  return client.auth.signUp({
    email: email.trim().toLowerCase(),
    password,
    options: {
      data: {
        display_name: name.trim(),
        role,
        class_name: className.trim(),
        class_code: classCode.trim().toUpperCase(),
      },
    },
  });
}

export async function signInPortal({ email, password }) {
  return requireSupabase().auth.signInWithPassword({
    email: email.trim().toLowerCase(),
    password,
  });
}

export async function signOutPortal() {
  const { error } = await requireSupabase().auth.signOut();
  if (error) throw error;
}

export async function resolvePortalSession(user, suppliedClassDetails = {}) {
  const client = requireSupabase();
  const { data: profile, error: profileError } = await client
    .from("profiles")
    .select("id, display_name, role")
    .eq("id", user.id)
    .single();
  if (profileError) throw profileError;

  const { data: membership, error: membershipError } = await client
    .from("class_members")
    .select("classroom_id")
    .eq("user_id", user.id)
    .eq("role", profile.role)
    .limit(1)
    .maybeSingle();
  if (membershipError) throw membershipError;

  let classroomId = membership?.classroom_id;
  if (!classroomId && profile.role === "teacher") {
    const className =
      suppliedClassDetails.className?.trim() ||
      user.user_metadata?.class_name?.trim() ||
      "My classroom";
    const { data, error } = await client.rpc("create_class_for_teacher", {
      p_class_name: className,
    });
    if (error) throw error;
    classroomId = data?.[0]?.id;
  } else if (!classroomId && profile.role === "student") {
    const classCode =
      suppliedClassDetails.classCode?.trim().toUpperCase() ||
      user.user_metadata?.class_code?.trim().toUpperCase();
    if (!classCode) {
      throw new Error(
        "This student account is not in a class yet. Sign in and enter the teacher’s invite code.",
      );
    }
    const { data, error } = await client.rpc("join_class_with_code", {
      p_invite_code: classCode,
    });
    if (error) throw error;
    classroomId = data?.[0]?.id;
  }
  if (!classroomId) {
    throw new Error("No classroom is linked to this account.");
  }

  const { data: classroom, error: classroomError } = await client
    .from("classrooms")
    .select("id, name, invite_code")
    .eq("id", classroomId)
    .single();
  if (classroomError) throw classroomError;

  return {
    userId: user.id,
    role: profile.role,
    name: profile.display_name,
    classId: classroom.id,
    className: classroom.name,
    inviteCode: classroom.invite_code,
  };
}

export async function uploadClassMaterial({
  classroomId,
  userId,
  file,
  questions,
  pageCount,
  slideCount,
}) {
  const client = requireSupabase();
  const fileId = crypto.randomUUID();
  const safeName = file.name.replace(/[^\w.-]+/g, "_");
  const storagePath = `${classroomId}/${fileId}-${safeName}`;
  const { error: uploadError } = await client.storage
    .from(MATERIAL_BUCKET)
    .upload(storagePath, file, {
      contentType: file.type || "application/octet-stream",
      upsert: false,
    });
  if (uploadError) throw uploadError;

  const { data, error: insertError } = await client
    .from("lesson_materials")
    .insert({
      classroom_id: classroomId,
      uploaded_by: userId,
      file_name: file.name,
      file_type: file.name.split(".").pop().toLowerCase(),
      storage_path: storagePath,
      quiz_questions: questions,
      page_count: pageCount,
      slide_count: slideCount,
    })
    .select("*")
    .single();
  if (insertError) {
    const { error: cleanupError } = await client.storage
      .from(MATERIAL_BUCKET)
      .remove([storagePath]);
    if (cleanupError) {
      throw new Error(
        `${insertError.message} The uploaded file could not be cleaned up: ${cleanupError.message}`,
      );
    }
    throw insertError;
  }
  return data;
}

export async function loadLatestClassMaterial(classroomId) {
  const client = requireSupabase();
  const { data: record, error } = await client
    .from("lesson_materials")
    .select("*")
    .eq("classroom_id", classroomId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!record) return null;

  const { data: signedFile, error: signedUrlError } = await client.storage
    .from(MATERIAL_BUCKET)
    .createSignedUrl(record.storage_path, 3600);
  if (signedUrlError) throw signedUrlError;
  const response = await fetch(signedFile.signedUrl);
  if (!response.ok) {
    throw new Error(`Could not download the shared lesson (${response.status}).`);
  }
  const blob = await response.blob();
  const file = new File([blob], record.file_name, {
    type: blob.type || "application/octet-stream",
  });
  return {
    record,
    file,
    url: URL.createObjectURL(file),
    isPdf: record.file_type === "pdf",
  };
}

export async function updateClassMaterialNotes(materialId, notes) {
  const { error } = await requireSupabase()
    .from("lesson_materials")
    .update({ notes })
    .eq("id", materialId);
  if (error) throw error;
}

export async function deleteClassMaterial(material) {
  const client = requireSupabase();
  const { error: deleteRowError } = await client
    .from("lesson_materials")
    .delete()
    .eq("id", material.id);
  if (deleteRowError) throw deleteRowError;
  const { error: deleteFileError } = await client.storage
    .from(MATERIAL_BUCKET)
    .remove([material.storage_path]);
  if (deleteFileError) {
    throw new Error(
      `The lesson record was removed, but its stored file could not be deleted: ${deleteFileError.message}`,
    );
  }
}

export async function loadQuizSubmission(classroomId, materialId) {
  const { data, error } = await requireSupabase()
    .from("quiz_submissions")
    .select("answers")
    .eq("classroom_id", classroomId)
    .eq("material_id", materialId)
    .maybeSingle();
  if (error) throw error;
  return data?.answers ?? {};
}

export async function saveQuizSubmission({
  classroomId,
  materialId,
  studentId,
  answers,
}) {
  const { error } = await requireSupabase().from("quiz_submissions").upsert(
    {
      classroom_id: classroomId,
      material_id: materialId,
      student_id: studentId,
      answers,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "student_id,material_id" },
  );
  if (error) throw error;
}

export async function loadClassResults(classroomId) {
  const { data, error } = await requireSupabase()
    .from("activity_results")
    .select("id, user_id, profile, mode, test, value, created_at")
    .eq("classroom_id", classroomId)
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) throw error;
  return data.map((result) => ({
    ...result,
    at: new Date(result.created_at).getTime(),
  }));
}

export async function saveClassResult({
  classroomId,
  userId,
  profile,
  mode,
  test,
  value,
}) {
  const { data, error } = await requireSupabase()
    .from("activity_results")
    .insert({
      classroom_id: classroomId,
      user_id: userId,
      profile,
      mode,
      test,
      value,
    })
    .select("id, user_id, profile, mode, test, value, created_at")
    .single();
  if (error) throw error;
  return { ...data, at: new Date(data.created_at).getTime() };
}

export async function clearUserClassResults(classroomId, userId) {
  const { error } = await requireSupabase()
    .from("activity_results")
    .delete()
    .eq("classroom_id", classroomId)
    .eq("user_id", userId);
  if (error) throw error;
}
